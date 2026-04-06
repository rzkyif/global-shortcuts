//! Global Shortcuts
//!
//! A standalone executable that registers global hotkeys using the system's native event loop.
//! Communication with Node.js happens via stdin/stdout JSON messages.
//!
//! On macOS and Windows, this uses Tao's event loop (required by global-hotkey).
//! On Linux, this uses a simple polling loop without Tao.

use global_hotkey::hotkey::{Code, HotKey as RustHotKey, Modifiers as RustModifiers};
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

// Tao imports - only available on macOS and Windows
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

/// Event sent from main thread to stdout
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggeredEvent {
  pub action: String,
  pub id: u32,
  pub state: String,
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

  fn append(&self, event: &TriggeredEvent) {
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

/// Parse a hotkey string like "ctrl+shift+a" into modifiers and key code
fn parse_hotkey(hotkey_str: &str) -> Result<(Option<RustModifiers>, Code), String> {
  let tokens: Vec<&str> = hotkey_str.split('+').collect();

  let mut modifiers = RustModifiers::empty();
  let mut key: Option<Code> = None;

  for token in tokens.iter() {
    let t = token.trim();
    if t.is_empty() {
      return Err(format!("Empty token in hotkey: {}", hotkey_str));
    }

    match t.to_uppercase().as_str() {
      "CTRL" | "CONTROL" => {
        modifiers.insert(RustModifiers::CONTROL);
      }
      "SHIFT" => {
        modifiers.insert(RustModifiers::SHIFT);
      }
      "ALT" | "OPTION" => {
        modifiers.insert(RustModifiers::ALT);
      }
      "SUPER" | "CMD" | "COMMAND" | "META" | "WINDOWS" => {
        modifiers.insert(RustModifiers::SUPER);
      }
      "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" | "COMMANDORCONTROL" => {
        #[cfg(target_os = "macos")]
        modifiers.insert(RustModifiers::SUPER);
        #[cfg(not(target_os = "macos"))]
        modifiers.insert(RustModifiers::CONTROL);
      }
      _ => {
        if key.is_some() {
          return Err(format!(
            "Invalid hotkey format: '{}', multiple main keys found",
            hotkey_str
          ));
        }
        key = Some(parse_key(t)?);
      }
    }
  }

  let key = key.ok_or_else(|| format!("No main key found in hotkey: {}", hotkey_str))?;

  Ok((Some(modifiers), key))
}

/// Parse a key string to Code enum
fn parse_key(key: &str) -> Result<Code, String> {
  use Code::*;

  match key.to_uppercase().as_str() {
    // Function keys
    "F1" => Ok(F1),
    "F2" => Ok(F2),
    "F3" => Ok(F3),
    "F4" => Ok(F4),
    "F5" => Ok(F5),
    "F6" => Ok(F6),
    "F7" => Ok(F7),
    "F8" => Ok(F8),
    "F9" => Ok(F9),
    "F10" => Ok(F10),
    "F11" => Ok(F11),
    "F12" => Ok(F12),
    "F13" => Ok(F13),
    "F14" => Ok(F14),
    "F15" => Ok(F15),
    "F16" => Ok(F16),
    "F17" => Ok(F17),
    "F18" => Ok(F18),
    "F19" => Ok(F19),
    "F20" => Ok(F20),
    "F21" => Ok(F21),
    "F22" => Ok(F22),
    "F23" => Ok(F23),
    "F24" => Ok(F24),

    // Letters
    "A" | "KEYA" => Ok(KeyA),
    "B" | "KEYB" => Ok(KeyB),
    "C" | "KEYC" => Ok(KeyC),
    "D" | "KEYD" => Ok(KeyD),
    "E" | "KEYE" => Ok(KeyE),
    "F" | "KEYF" => Ok(KeyF),
    "G" | "KEYG" => Ok(KeyG),
    "H" | "KEYH" => Ok(KeyH),
    "I" | "KEYI" => Ok(KeyI),
    "J" | "KEYJ" => Ok(KeyJ),
    "K" | "KEYK" => Ok(KeyK),
    "L" | "KEYL" => Ok(KeyL),
    "M" | "KEYM" => Ok(KeyM),
    "N" | "KEYN" => Ok(KeyN),
    "O" | "KEYO" => Ok(KeyO),
    "P" | "KEYP" => Ok(KeyP),
    "Q" | "KEYQ" => Ok(KeyQ),
    "R" | "KEYR" => Ok(KeyR),
    "S" | "KEYS" => Ok(KeyS),
    "T" | "KEYT" => Ok(KeyT),
    "U" | "KEYU" => Ok(KeyU),
    "V" | "KEYV" => Ok(KeyV),
    "W" | "KEYW" => Ok(KeyW),
    "X" | "KEYX" => Ok(KeyX),
    "Y" | "KEYY" => Ok(KeyY),
    "Z" | "KEYZ" => Ok(KeyZ),

    // Digits
    "0" | "DIGIT0" => Ok(Digit0),
    "1" | "DIGIT1" => Ok(Digit1),
    "2" | "DIGIT2" => Ok(Digit2),
    "3" | "DIGIT3" => Ok(Digit3),
    "4" | "DIGIT4" => Ok(Digit4),
    "5" | "DIGIT5" => Ok(Digit5),
    "6" | "DIGIT6" => Ok(Digit6),
    "7" | "DIGIT7" => Ok(Digit7),
    "8" | "DIGIT8" => Ok(Digit8),
    "9" | "DIGIT9" => Ok(Digit9),

    // Special keys
    "SPACE" => Ok(Space),
    "ENTER" => Ok(Enter),
    "TAB" => Ok(Tab),
    "ESCAPE" | "ESC" => Ok(Escape),
    "BACKSPACE" => Ok(Backspace),
    "DELETE" | "DEL" => Ok(Delete),

    // Arrow keys
    "UP" | "ARROWUP" => Ok(ArrowUp),
    "DOWN" | "ARROWDOWN" => Ok(ArrowDown),
    "LEFT" | "ARROWLEFT" => Ok(ArrowLeft),
    "RIGHT" | "ARROWRIGHT" => Ok(ArrowRight),

    // Navigation keys
    "HOME" => Ok(Home),
    "END" => Ok(End),
    "PAGEUP" => Ok(PageUp),
    "PAGEDOWN" => Ok(PageDown),
    "INSERT" => Ok(Insert),

    // Lock keys
    "CAPSLOCK" => Ok(CapsLock),
    "NUMLOCK" => Ok(NumLock),
    "SCROLLLOCK" => Ok(ScrollLock),
    "PRINTSCREEN" | "PRINT" => Ok(PrintScreen),
    "PAUSE" => Ok(Pause),

    // Punctuation
    "MINUS" | "-" => Ok(Minus),
    "EQUAL" | "=" => Ok(Equal),
    "BRACKETLEFT" | "[" => Ok(BracketLeft),
    "BRACKETRIGHT" | "]" => Ok(BracketRight),
    "BACKSLASH" | "\\" => Ok(Backslash),
    "SEMICOLON" | ";" => Ok(Semicolon),
    "QUOTE" | "'" => Ok(Quote),
    "BACKQUOTE" | "`" => Ok(Backquote),
    "COMMA" | "," => Ok(Comma),
    "PERIOD" | "." => Ok(Period),
    "SLASH" | "/" => Ok(Slash),

    // Numpad
    "NUMPAD0" | "NUM0" => Ok(Numpad0),
    "NUMPAD1" | "NUM1" => Ok(Numpad1),
    "NUMPAD2" | "NUM2" => Ok(Numpad2),
    "NUMPAD3" | "NUM3" => Ok(Numpad3),
    "NUMPAD4" | "NUM4" => Ok(Numpad4),
    "NUMPAD5" | "NUM5" => Ok(Numpad5),
    "NUMPAD6" | "NUM6" => Ok(Numpad6),
    "NUMPAD7" | "NUM7" => Ok(Numpad7),
    "NUMPAD8" | "NUM8" => Ok(Numpad8),
    "NUMPAD9" | "NUM9" => Ok(Numpad9),
    "NUMPADADD" | "NUMADD" | "NUMPADPLUS" | "NUMPLUS" => Ok(NumpadAdd),
    "NUMPADSUBTRACT" | "NUMSUBTRACT" => Ok(NumpadSubtract),
    "NUMPADMULTIPLY" | "NUMMULTIPLY" => Ok(NumpadMultiply),
    "NUMPADDIVIDE" | "NUMDIVIDE" => Ok(NumpadDivide),
    "NUMPADDECIMAL" | "NUMDECIMAL" => Ok(NumpadDecimal),
    "NUMPADENTER" | "NUMENTER" => Ok(NumpadEnter),
    "NUMPADEQUAL" | "NUMEQUAL" => Ok(NumpadEqual),

    // Media keys
    "VOLUMEUP" | "AUDIOVOLUMEUP" => Ok(AudioVolumeUp),
    "VOLUMEDOWN" | "AUDIOVOLUMEDOWN" => Ok(AudioVolumeDown),
    "VOLUMEMUTE" | "AUDIOVOLUMEMUTE" => Ok(AudioVolumeMute),
    "MEDIAPLAY" => Ok(MediaPlay),
    "MEDIAPAUSE" => Ok(MediaPause),
    "MEDIAPLAYPAUSE" => Ok(MediaPlayPause),
    "MEDIASTOP" => Ok(MediaStop),
    "MEDIATRACKNEXT" => Ok(MediaTrackNext),
    "MEDIATRACKPREV" | "MEDIATRACKPREVIOUS" => Ok(MediaTrackPrevious),

    _ => Err(format!("Unsupported key: {}", key)),
  }
}

/// Send a message to stdout with buffering to prevent flooding
fn send_event(output_buffer: &OutputBuffer, event: &TriggeredEvent) {
  output_buffer.append(event);
  // Flush immediately for important events
  if event.action == "ready" || event.action == "registered" || event.action == "unregistered" {
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
          match parse_hotkey(&hotkey) {
            Ok((mods, code)) => {
              let rust_hotkey = RustHotKey::new(mods, code);
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
                  send_event(
                    output_buffer,
                    &TriggeredEvent {
                      action: "registered".to_string(),
                      id,
                      state: "success".to_string(),
                    },
                  );
                }
                Err(e) => {
                  debug_log("error", &format!("Register failed: id={}, error={}", id, e));
                  send_event(
                    output_buffer,
                    &TriggeredEvent {
                      action: "error".to_string(),
                      id,
                      state: format!("Failed to register: {}", e),
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
                &TriggeredEvent {
                  action: "error".to_string(),
                  id,
                  state: format!("Failed to parse hotkey: {}", e),
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
                &TriggeredEvent {
                  action: "error".to_string(),
                  id,
                  state: format!("Failed to unregister: {}", e),
                },
              );
            } else {
              debug_log("debug", &format!("Unregister success: id={}", id));
              send_event(
                output_buffer,
                &TriggeredEvent {
                  action: "unregistered".to_string(),
                  id,
                  state: "success".to_string(),
                },
              );
            }
          } else {
            debug_log(
              "debug",
              &format!("Unregister: id={} not found in map, sending success", id),
            );
            send_event(
              output_buffer,
              &TriggeredEvent {
                action: "unregistered".to_string(),
                id,
                state: "success".to_string(),
              },
            );
          }
        }
        Command::RegisterAll { hotkeys } => {
          debug_log(
            "debug",
            &format!("Received register_all: {} hotkeys", hotkeys.len()),
          );

          // First pass: parse all hotkeys and collect errors
          let mut parsed_hotkeys: Vec<(u32, RustHotKey)> = Vec::new();
          let mut errors: Vec<(u32, String)> = Vec::new();

          for entry in hotkeys {
            match parse_hotkey(&entry.hotkey) {
              Ok((mods, code)) => {
                let rust_hotkey = RustHotKey::new(mods, code);
                parsed_hotkeys.push((entry.id, rust_hotkey));
              }
              Err(e) => {
                errors.push((entry.id, e));
              }
            }
          }

          // Send parse errors immediately
          for (id, error_msg) in &errors {
            send_event(
              output_buffer,
              &TriggeredEvent {
                action: "error".to_string(),
                id: *id,
                state: format!("Failed to parse hotkey: {}", error_msg),
              },
            );
          }

          // If no hotkeys could be parsed, we're done
          if parsed_hotkeys.is_empty() {
            debug_log("debug", "RegisterAll: no valid hotkeys to register");
            send_event(
              output_buffer,
              &TriggeredEvent {
                action: "registered_all".to_string(),
                id: 0,
                state: "success".to_string(),
              },
            );
            return false;
          }

          // Try to register all hotkeys at once
          let rust_hotkeys: Vec<RustHotKey> = parsed_hotkeys.iter().map(|(_, h)| *h).collect();

          match manager.register_all(&rust_hotkeys) {
            Ok(_) => {
              // Registration succeeded for all parsed hotkeys
              for (id, hotkey) in &parsed_hotkeys {
                let rust_id = hotkey.id();
                registered_hotkeys.insert(
                  *id,
                  RegisteredHotkey {
                    node_id: *id,
                    rust_id,
                    hotkey: *hotkey,
                  },
                );
                rust_to_node_id.insert(rust_id, *id);
              }
              debug_log(
                "debug",
                &format!(
                  "RegisterAll success: {} hotkeys registered",
                  parsed_hotkeys.len()
                ),
              );
              send_event(
                output_buffer,
                &TriggeredEvent {
                  action: "registered_all".to_string(),
                  id: 0,
                  state: "success".to_string(),
                },
              );
            }
            Err(e) => {
              // Batch registration failed - this is a critical error
              debug_log("error", &format!("RegisterAll batch failed: {}", e));
              // Send error for each hotkey that would have been registered
              for (id, _) in &parsed_hotkeys {
                send_event(
                  output_buffer,
                  &TriggeredEvent {
                    action: "error".to_string(),
                    id: *id,
                    state: format!("Failed to register: {}", e),
                  },
                );
              }
              send_event(
                output_buffer,
                &TriggeredEvent {
                  action: "error".to_string(),
                  id: 0,
                  state: format!("Failed to register all: {}", e),
                },
              );
            }
          }
        }
        Command::UnregisterAll { ids } => {
          debug_log(
            "debug",
            &format!("Received unregister_all: {} ids", ids.len()),
          );

          let mut errors: Vec<(u32, String)> = Vec::new();
          let mut unregistered_count = 0;

          for &id in &ids {
            if let Some(reg) = registered_hotkeys.remove(&id) {
              rust_to_node_id.remove(&reg.rust_id);
              if let Err(e) = manager.unregister(reg.hotkey) {
                errors.push((id, format!("Failed to unregister: {}", e)));
              } else {
                unregistered_count += 1;
              }
            }
          }

          debug_log(
            "debug",
            &format!(
              "UnregisterAll: {} unregistered, {} errors",
              unregistered_count,
              errors.len()
            ),
          );

          // Always send final event
          if errors.is_empty() {
            send_event(
              output_buffer,
              &TriggeredEvent {
                action: "unregistered_all".to_string(),
                id: 0,
                state: "success".to_string(),
              },
            );
          } else {
            // Send individual errors
            for (id, error_msg) in &errors {
              send_event(
                output_buffer,
                &TriggeredEvent {
                  action: "error".to_string(),
                  id: *id,
                  state: error_msg.clone(),
                },
              );
            }
            // Still send unregistered_all with partial success info
            send_event(
              output_buffer,
              &TriggeredEvent {
                action: "unregistered_all".to_string(),
                id: 0,
                state: format!(
                  "partial: {} unregistered, {} failed",
                  unregistered_count,
                  errors.len()
                ),
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
      &TriggeredEvent {
        action: "triggered".to_string(),
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
  send_event(
    &output_buffer,
    &TriggeredEvent {
      action: "ready".to_string(),
      id: 0,
      state: "true".to_string(),
    },
  );

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
  send_event(
    &output_buffer,
    &TriggeredEvent {
      action: "ready".to_string(),
      id: 0,
      state: "true".to_string(),
    },
  );

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
