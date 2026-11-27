use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use midir::{Ignore, MidiInput, MidiInputConnection};
use serde_json::json;

use crate::protocol::event_frame;

const CLIENT_NAME: &str = "PracticeMusic";
const PEDAL_CONTROLLER: u8 = 4;
const PEDAL_STEP: u8 = 6;
const PEDAL_QUIET: Duration = Duration::from_millis(60);
const GRAB_PRESSURE: u8 = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Message {
    Hit { note: u8, velocity: u8 },
    Release { note: u8 },
    Grab { note: u8, pressure: u8 },
    Pedal { value: u8 },
}

pub fn parse(bytes: &[u8]) -> Option<Message> {
    if bytes.len() < 3 {
        return None;
    }
    let (status, first, second) = (bytes[0] & 0xf0, bytes[1], bytes[2]);
    if first > 127 || second > 127 {
        return None;
    }
    match status {
        0x90 if second > 0 => Some(Message::Hit {
            note: first,
            velocity: second,
        }),
        0x90 | 0x80 => Some(Message::Release { note: first }),
        0xa0 => Some(Message::Grab {
            note: first,
            pressure: second,
        }),
        0xb0 if first == PEDAL_CONTROLLER => Some(Message::Pedal { value: second }),
        _ => None,
    }
}

#[derive(Default)]
pub struct Report {
    sequence: u64,
    pedal: Option<(u8, Instant)>,
    grabbed: u128,
}

impl Report {
    pub fn describe(&mut self, message: Message, now: Instant) -> Option<serde_json::Value> {
        let (kind, note, value) = match message {
            Message::Hit { note, velocity } => ("hit", note, velocity),
            Message::Release { .. } => return None,
            Message::Grab { note, pressure } => {
                let bit = 1u128 << (note & 127);
                let held = pressure >= GRAB_PRESSURE;
                let was = self.grabbed & bit != 0;
                self.grabbed = if held {
                    self.grabbed | bit
                } else {
                    self.grabbed & !bit
                };
                if !held || was {
                    return None;
                }
                ("grab", note, pressure)
            }
            Message::Pedal { value } => {
                if let Some((last, at)) = self.pedal {
                    let small = value.abs_diff(last) < PEDAL_STEP && value != 0 && value != 127;
                    if value == last || (small && now.duration_since(at) < PEDAL_QUIET) {
                        return None;
                    }
                }
                self.pedal = Some((value, now));
                ("pedal", 0, value)
            }
        };
        self.sequence += 1;
        Some(json!({ "seq": self.sequence, "kind": kind, "note": note, "value": value }))
    }
}

fn client() -> Result<MidiInput, String> {
    let mut input = MidiInput::new(CLIENT_NAME).map_err(|e| e.to_string())?;
    input.ignore(Ignore::All);
    Ok(input)
}

pub fn list_ports() -> Result<Vec<String>, String> {
    let input = client()?;
    Ok(input
        .ports()
        .iter()
        .filter_map(|port| input.port_name(port).ok())
        .collect())
}

pub struct Link {
    _connection: MidiInputConnection<()>,
    pub name: String,
}

pub fn open(name: &str, events: Sender<String>) -> Result<Link, String> {
    let input = client()?;
    let port = input
        .ports()
        .into_iter()
        .find(|port| input.port_name(port).is_ok_and(|found| found == name))
        .ok_or_else(|| format!("the MIDI device {name} is not connected"))?;
    let mut report = Report::default();
    let connection = input
        .connect(
            &port,
            CLIENT_NAME,
            move |_, bytes, _| {
                let Some(message) = parse(bytes) else {
                    return;
                };
                if let Some(data) = report.describe(message, Instant::now()) {
                    let _ = events.send(event_frame("midi", data));
                }
            },
            (),
        )
        .map_err(|e| format!("could not open {name}: {e}"))?;
    Ok(Link {
        _connection: connection,
        name: name.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_messages_become_hits_and_releases_on_any_channel() {
        assert_eq!(
            parse(&[0x99, 38, 100]),
            Some(Message::Hit {
                note: 38,
                velocity: 100
            })
        );
        assert_eq!(parse(&[0x99, 38, 0]), Some(Message::Release { note: 38 }));
        assert_eq!(parse(&[0x80, 38, 64]), Some(Message::Release { note: 38 }));
    }

    #[test]
    fn the_hi_hat_pedal_and_cymbal_grabs_are_read() {
        assert_eq!(parse(&[0xb9, 4, 90]), Some(Message::Pedal { value: 90 }));
        assert_eq!(
            parse(&[0xa9, 49, 127]),
            Some(Message::Grab {
                note: 49,
                pressure: 127
            })
        );
        assert_eq!(parse(&[0xb9, 7, 90]), None);
        assert_eq!(parse(&[0xf8]), None);
        assert_eq!(parse(&[0x99, 200, 1]), None);
    }

    #[test]
    fn the_report_to_the_interface_is_quiet_about_pedal_noise_and_held_grabs() {
        let mut report = Report::default();
        let now = Instant::now();
        let hit = report.describe(
            Message::Hit {
                note: 38,
                velocity: 99,
            },
            now,
        );
        assert_eq!(hit.unwrap()["seq"], 1);
        assert!(report.describe(Message::Pedal { value: 40 }, now).is_some());
        assert!(report.describe(Message::Pedal { value: 42 }, now).is_none());
        assert!(
            report
                .describe(Message::Pedal { value: 127 }, now)
                .is_some()
        );
        let grab = Message::Grab {
            note: 49,
            pressure: 120,
        };
        assert!(report.describe(grab, now).is_some());
        assert!(report.describe(grab, now).is_none());
        assert!(
            report
                .describe(Message::Release { note: 38 }, now)
                .is_none()
        );
    }
}
