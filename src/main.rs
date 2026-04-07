//! Global Shortcuts - Registers global hotkeys via stdin/stdout JSON protocol.

use global_hotkey::hotkey::HotKey as RustHotKey;
use global_hotkey::{
  GlobalHotKeyEvent, GlobalHotKeyManager as RustGlobalHotKeyManager, HotKeyState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

#[cfg(not(target_os = "linux"))]
use std::time::Instant;
#[cfg(not(target_os = "linux"))]
use tao::event_loop::ControlFlow;
#[cfg(target_os = "macos")]
use tao::platform::macos::EventLoopExtMacOS;

/// Message sent from stdin thread to main event loop thread
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum Command {
  #[serde(rename = "register")]
  Register { hotkey: String, id: u32 },
  #[serde(rename = "unregister")]
  Unregister { id: u32 },
  #[serde(rename = "register_all")]
  RegisterAll { hotkeys: Vec<HotKeyEntry> },
  #[serde(rename = "unregister_all")]
  UnregisterAll { ids: Vec<u32> },
}

/// Hotkey entry with ID
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotKeyEntry {
  pub hotkey: String,
  pub id: u32,
}

/// Events sent from main thread to stdout
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "action")]
pub enum OutputEvent {
  #[serde(rename = "ready")]
  Ready,
  #[serde(rename = "registered")]
  Registered { id: u32 },
  #[serde(rename = "unregistered")]
  Unregistered { id: u32 },
  #[serde(rename = "registered_all")]
  RegisteredAll { ids: Vec<u32> },
  #[serde(rename = "registered_all_partial")]
  RegisteredAllPartial { results: Vec<BatchResult> },
  #[serde(rename = "unregistered_all")]
  UnregisteredAll { ids: Vec<u32> },
  #[serde(rename = "unregistered_all_partial")]
  UnregisteredAllPartial { results: Vec<BatchResult> },
  #[serde(rename = "triggered")]
  Triggered { id: u32, state: String },
  #[serde(rename = "error")]
  Error { id: Option<u32>, message: String },
}

/// Generic result entry for batch operations
#[derive(Debug, Clone, Serialize)]
pub struct BatchResult {
  pub id: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// Debug log event written to stderr
#[derive(Debug, Clone, Serialize)]
struct DebugLog {
  level: String,
  message: String,
}

/// Global debug flag, set at startup
static DEBUG_ENABLED: AtomicBool = AtomicBool::new(false);

/// Output buffer for stdout to prevent flooding
struct OutputBuffer {
  buffer: Mutex<String>,
}

impl OutputBuffer {
  fn new() -> Self {
    Self {
      buffer: Mutex::new(String::new()),
    }
  }

  fn append(&self, event: &OutputEvent) {
    let json = serde_json::to_string(event).unwrap();
    let mut buf = self.buffer.lock().unwrap();
    buf.push_str(&json);
    buf.push('\n');
  }

  fn flush(&self) {
    let mut buf = self.buffer.lock().unwrap();
    if !buf.is_empty() {
      print!("{}", &*buf);
      io::stdout().flush().ok();
      buf.clear();
    }
  }
}

/// Internal debug log to stderr (won't interfere with stdout protocol)
fn debug_log(level: &str, message: &str) {
  let msg = serde_json::to_string(&DebugLog {
    level: level.to_string(),
    message: message.to_string(),
  })
  .unwrap_or_else(|_| {
    "{\"level\":\"error\",\"message\":\"Failed to serialize debug log\"}".to_string()
  });
  if level == "error" || DEBUG_ENABLED.load(Ordering::Relaxed) {
    eprintln!("{}", msg);
    io::stderr().flush().ok();
  }
}

/// Store both the node ID and the Rust-generated hotkey ID
struct RegisteredHotkey {
  #[allow(dead_code)]
  node_id: u32,
  rust_id: u32,
  hotkey: RustHotKey,
}

/// Helper to determine if an event should be flushed immediately
fn should_flush_immediately(event: &OutputEvent) -> bool {
  matches!(
    event,
    OutputEvent::Ready | OutputEvent::Registered { .. } | OutputEvent::Unregistered { .. }
  )
}

/// Send a message to stdout with buffering to prevent flooding
fn send_event(output_buffer: &OutputBuffer, event: OutputEvent) {
  let flush = should_flush_immediately(&event);
  output_buffer.append(&event);
  if flush {
    output_buffer.flush();
  }
}

/// Spawn a background thread to read from stdin.
/// Returns a channel receiver that will be disconnected when stdin is closed.
fn spawn_stdin_reader() -> mpsc::Receiver<Command> {
  let (tx, rx) = mpsc::channel();

  thread::spawn(move || {
    let stdin = io::stdin();
    let mut handle = stdin.lock();
    let mut buffer = String::new();

    loop {
      buffer.clear();
      match handle.read_line(&mut buffer) {
        Ok(0) => {
          // EOF reached - exit thread, dropping tx and signaling disconnection
          break;
        }
        Ok(_) => {
          let line = buffer.trim();
          if line.is_empty() {
            continue;
          }
          match serde_json::from_str::<Command>(line) {
            Ok(cmd) => {
              if tx.send(cmd).is_err() {
                break;
              }
            }
            Err(e) => {
              eprintln!("Failed to parse JSON: {}", e);
            }
          }
        }
        Err(e) => {
          eprintln!("Failed to read from stdin: {}", e);
          break;
        }
      }
    }
    // When this thread exits, tx is dropped, which will disconnect the channel
  });

  rx
}

/// Process all pending commands from stdin.
/// Returns true if the channel is disconnected and the program should exit.
fn process_commands(
  rx: &mpsc::Receiver<Command>,
  registered_hotkeys: &mut HashMap<u32, RegisteredHotkey>,
  rust_to_node_id: &mut HashMap<u32, u32>,
  manager: &RustGlobalHotKeyManager,
  output_buffer: &OutputBuffer,
) -> bool {
  loop {
    match rx.try_recv() {
      Ok(cmd) => match cmd {
        Command::Register { hotkey, id } => {
          debug_log(
            "debug",
            &format!("Received register: id={}, hotkey='{}'", id, hotkey),
          );
          match hotkey.parse::<RustHotKey>() {
            Ok(rust_hotkey) => {
              let rust_id = rust_hotkey.id();
              debug_log("debug", &format!("Parsed hotkey, rust_id={}", rust_id));
              match manager.register(rust_hotkey) {
                Ok(_) => {
                  registered_hotkeys.insert(
                    id,
                    RegisteredHotkey {
                      node_id: id,
                      rust_id,
                      hotkey: rust_hotkey,
                    },
                  );
                  rust_to_node_id.insert(rust_id, id);
                  debug_log("debug", &format!("Register success: id={}", id));
                  send_event(output_buffer, OutputEvent::Registered { id });
                }
                Err(e) => {
                  debug_log("error", &format!("Register failed: id={}, error={}", id, e));
                  send_event(
                    output_buffer,
                    OutputEvent::Error {
                      id: Some(id),
                      message: format!("Failed to register: {}", e),
                    },
                  );
                }
              }
            }
            Err(e) => {
              debug_log(
                "error",
                &format!("Parse hotkey failed: id={}, error={}", id, e),
              );
              send_event(
                output_buffer,
                OutputEvent::Error {
                  id: Some(id),
                  message: format!("Failed to parse hotkey: {}", e),
                },
              );
            }
          }
        }
        Command::Unregister { id, .. } => {
          debug_log("debug", &format!("Received unregister: id={}", id));
          if let Some(reg) = registered_hotkeys.remove(&id) {
            rust_to_node_id.remove(&reg.rust_id);
            if let Err(e) = manager.unregister(reg.hotkey) {
              debug_log(
                "error",
                &format!("Unregister failed: id={}, error={}", id, e),
              );
              send_event(
                output_buffer,
                OutputEvent::Error {
                  id: Some(id),
                  message: format!("Failed to unregister: {}", e),
                },
              );
            } else {
              debug_log("debug", &format!("Unregister success: id={}", id));
              send_event(output_buffer, OutputEvent::Unregistered { id });
            }
          } else {
            debug_log(
              "debug",
              &format!("Unregister: id={} not found in map, sending success", id),
            );
            send_event(output_buffer, OutputEvent::Unregistered { id });
          }
        }
        Command::RegisterAll { hotkeys } => {
          debug_log(
            "debug",
            &format!("Received register_all: {} hotkeys", hotkeys.len()),
          );

          if hotkeys.is_empty() {
            debug_log("debug", "RegisterAll: empty input, returning empty array");
            send_event(output_buffer, OutputEvent::RegisteredAll { ids: vec![] });
            return false;
          }

          // Build an ordered results array to maintain input order
          // Each entry: (node_id, Result<(), String>)
          let mut results: Vec<(u32, Result<(), String>)> = Vec::new();

          // First pass: parse all hotkeys
          let mut parsed_hotkeys: Vec<(u32, RustHotKey)> = Vec::new();
          let mut parse_errors: HashMap<u32, String> = HashMap::new();

          for entry in &hotkeys {
            match entry.hotkey.parse::<RustHotKey>() {
              Ok(hk) => parsed_hotkeys.push((entry.id, hk)),
              Err(e) => {
                parse_errors.insert(entry.id, format!("Failed to parse hotkey: {}", e));
              }
            }
          }

          for entry in &hotkeys {
            if let Some(err) = parse_errors.get(&entry.id) {
              results.push((entry.id, Err(err.clone())));
            } else {
              results.push((entry.id, Ok(())));
            }
          }

          // Second pass: register each hotkey individually
          for (node_id, hotkey) in &parsed_hotkeys {
            let rust_id = hotkey.id();
            match manager.register(*hotkey) {
              Ok(_) => {
                registered_hotkeys.insert(
                  *node_id,
                  RegisteredHotkey {
                    node_id: *node_id,
                    rust_id,
                    hotkey: *hotkey,
                  },
                );
                rust_to_node_id.insert(rust_id, *node_id);
              }
              Err(e) => {
                let error_msg = format!("Failed to register: {}", e);
                debug_log(
                  "error",
                  &format!("Register failed: id={}, error={}", node_id, e),
                );
                for (rid, result) in &mut results {
                  if *rid == *node_id {
                    *result = Err(error_msg.clone());
                    break;
                  }
                }
              }
            }
          }

          // Check if all succeeded
          let all_success = results.iter().all(|(_, r)| r.is_ok());
          let success_count = results.iter().filter(|(_, r)| r.is_ok()).count();
          debug_log(
            "debug",
            &format!(
              "RegisterAll: {}/{} hotkeys registered",
              success_count,
              results.len()
            ),
          );

          let success_ids: Vec<u32> = results.iter().map(|(id, _)| *id).collect();
          if all_success {
            send_event(
              output_buffer,
              OutputEvent::RegisteredAll { ids: success_ids },
            );
          } else {
            send_event(
              output_buffer,
              OutputEvent::RegisteredAllPartial {
                results: results
                  .iter()
                  .map(|(id, r)| match r {
                    Ok(_) => BatchResult {
                      id: *id,
                      error: None,
                    },
                    Err(e) => BatchResult {
                      id: *id,
                      error: Some(e.clone()),
                    },
                  })
                  .collect(),
              },
            );
          }
        }

        Command::UnregisterAll { ids } => {
          debug_log(
            "debug",
            &format!("Received unregister_all: {} ids", ids.len()),
          );

          if ids.is_empty() {
            debug_log("debug", "UnregisterAll: empty input, returning empty array");
            send_event(output_buffer, OutputEvent::UnregisteredAll { ids: vec![] });
            return false;
          }

          // Build ordered results array maintaining input order
          // Each entry: (id, Result<(), String>)
          let mut results: Vec<(u32, Result<(), String>)> = Vec::new();

          for &id in &ids {
            if let Some(reg) = registered_hotkeys.remove(&id) {
              rust_to_node_id.remove(&reg.rust_id);
              if let Err(e) = manager.unregister(reg.hotkey) {
                debug_log(
                  "error",
                  &format!("Unregister failed: id={}, error={}", id, e),
                );
                results.push((id, Err(format!("Failed to unregister: {}", e))));
              } else {
                debug_log("debug", &format!("Unregister success: id={}", id));
                results.push((id, Ok(())));
              }
            } else {
              // ID not found - treat as success (already unregistered)
              debug_log(
                "debug",
                &format!("Unregister: id={} not found, treating as success", id),
              );
              results.push((id, Ok(())));
            }
          }

          // Check if all succeeded
          let all_success = results.iter().all(|(_, r)| r.is_ok());
          let success_count = results.iter().filter(|(_, r)| r.is_ok()).count();
          debug_log(
            "debug",
            &format!(
              "UnregisterAll: {}/{} hotkeys unregistered",
              success_count,
              results.len()
            ),
          );

          let success_ids: Vec<u32> = results.iter().map(|(id, _)| *id).collect();
          if all_success {
            send_event(
              output_buffer,
              OutputEvent::UnregisteredAll { ids: success_ids },
            );
          } else {
            send_event(
              output_buffer,
              OutputEvent::UnregisteredAllPartial {
                results: results
                  .iter()
                  .map(|(id, r)| match r {
                    Ok(_) => BatchResult {
                      id: *id,
                      error: None,
                    },
                    Err(e) => BatchResult {
                      id: *id,
                      error: Some(e.clone()),
                    },
                  })
                  .collect(),
              },
            );
          }
        }
      },
      Err(mpsc::TryRecvError::Empty) => {
        // No more messages for now
        return false;
      }
      Err(mpsc::TryRecvError::Disconnected) => {
        return true;
      }
    }
  }
}

/// Process hotkey events from the global hotkey manager
fn process_hotkey_events(output_buffer: &OutputBuffer, rust_to_node_id: &HashMap<u32, u32>) {
  while let Ok(event) = GlobalHotKeyEvent::receiver().try_recv() {
    let state_str = match event.state {
      HotKeyState::Pressed => "Pressed",
      HotKeyState::Released => "Released",
    };
    // Use rust_id as fallback, but try to find node_id
    let node_id = rust_to_node_id.get(&event.id).copied().unwrap_or(event.id);
    debug_log(
      "debug",
      &format!(
        "Hotkey triggered: rust_id={}, node_id={}, state={}",
        event.id, node_id, state_str
      ),
    );
    send_event(
      output_buffer,
      OutputEvent::Triggered {
        id: node_id,
        state: state_str.to_string(),
      },
    );
  }
}

// Platform-specific main functions

/// macOS/Windows implementation using Tao event loop
#[cfg(not(target_os = "linux"))]
fn main_impl() {
  // Initialize debug mode from environment variable
  let debug_env = std::env::var("DEBUG").unwrap_or_default();
  let debug_on = debug_env == "true" || debug_env == "global-shortcuts";
  DEBUG_ENABLED.store(debug_on, Ordering::Relaxed);

  debug_log("debug", "Sidecar starting up");
  if debug_on {
    debug_log("debug", &format!("Debug mode enabled: DEBUG={}", debug_env));
  }
  debug_log("debug", &format!("PID: {}", std::process::id()));

  // Create the event loop on the main thread (required for macOS)
  let mut event_loop: tao::event_loop::EventLoop<()> = tao::event_loop::EventLoop::new();

  // Create a channel to communicate from stdin thread to event loop
  let rx = spawn_stdin_reader();

  // Create the global hotkey manager
  let manager = match RustGlobalHotKeyManager::new() {
    Ok(m) => m,
    Err(e) => {
      eprintln!("Failed to create GlobalHotKeyManager: {}", e);
      std::process::exit(1);
    }
  };

  // Mutable state: map node_id -> RegisteredHotkey
  let mut registered_hotkeys: HashMap<u32, RegisteredHotkey> = HashMap::new();
  // Reverse lookup: rust_id -> node_id
  let mut rust_to_node_id: HashMap<u32, u32> = HashMap::new();

  // Create output buffer for stdout
  let output_buffer = OutputBuffer::new();

  // Send ready message to indicate sidecar is ready to receive commands
  debug_log("debug", "Sending ready event to stdout");
  send_event(&output_buffer, OutputEvent::Ready);

  // Set activation policy to Accessory to hide dock icon in MacOS
  #[cfg(target_os = "macos")]
  event_loop.set_activation_policy(tao::platform::macos::ActivationPolicy::Accessory);

  // Run the event loop
  event_loop.run(move |_event, _window_target, control_flow| {
    // Process all pending commands from stdin and check for disconnect
    if process_commands(
      &rx,
      &mut registered_hotkeys,
      &mut rust_to_node_id,
      &manager,
      &output_buffer,
    ) {
      *control_flow = ControlFlow::Exit;
      return;
    }

    // Flush output buffer periodically
    output_buffer.flush();

    // Process global hotkey events - convert rust_id to node_id
    process_hotkey_events(&output_buffer, &rust_to_node_id);

    // Use WaitUntil with a short timeout to periodically poll the stdin channel.
    // This is necessary because the stdin channel doesn't wake up the event loop.
    *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(10));
  });
}

/// Linux implementation using a simple polling loop without Tao
#[cfg(target_os = "linux")]
fn main_impl() {
  // Initialize debug mode from environment variable
  let debug_env = std::env::var("DEBUG").unwrap_or_default();
  let debug_on = debug_env == "true" || debug_env == "global-shortcuts";
  DEBUG_ENABLED.store(debug_on, Ordering::Relaxed);

  debug_log("debug", "Sidecar starting up (Linux polling mode)");
  if debug_on {
    debug_log("debug", &format!("Debug mode enabled: DEBUG={}", debug_env));
  }
  debug_log("debug", &format!("PID: {}", std::process::id()));

  // Create a channel to communicate from stdin thread to main loop
  let rx = spawn_stdin_reader();

  // Create the global hotkey manager
  let manager = match RustGlobalHotKeyManager::new() {
    Ok(m) => m,
    Err(e) => {
      eprintln!("Failed to create GlobalHotKeyManager: {}", e);
      std::process::exit(1);
    }
  };

  // Mutable state: map node_id -> RegisteredHotkey
  let mut registered_hotkeys: HashMap<u32, RegisteredHotkey> = HashMap::new();
  // Reverse lookup: rust_id -> node_id
  let mut rust_to_node_id: HashMap<u32, u32> = HashMap::new();

  // Create output buffer for stdout
  let output_buffer = OutputBuffer::new();

  // Send ready message to indicate sidecar is ready to receive commands
  debug_log("debug", "Sending ready event to stdout");
  send_event(&output_buffer, OutputEvent::Ready);

  // Simple polling loop - no event loop needed on Linux
  loop {
    // Process all pending commands from stdin and check for disconnect
    if process_commands(
      &rx,
      &mut registered_hotkeys,
      &mut rust_to_node_id,
      &manager,
      &output_buffer,
    ) {
      debug_log("debug", "Stdin disconnected, exiting");
      return;
    }

    // Flush output buffer periodically
    output_buffer.flush();

    // Process global hotkey events - convert rust_id to node_id
    process_hotkey_events(&output_buffer, &rust_to_node_id);

    // Sleep briefly to avoid busy-waiting
    thread::sleep(Duration::from_millis(10));
  }
}

/// Main entry point
fn main() {
  main_impl();
}
