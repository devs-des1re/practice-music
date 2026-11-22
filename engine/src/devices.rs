use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{SupportedBufferSize, SupportedStreamConfigRange};
use serde_json::{Value, json};

use crate::protocol::ProtoError;

const STANDARD_RATES: [u32; 8] = [22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Input,
    Output,
}

impl Direction {
    fn label(self) -> &'static str {
        match self {
            Direction::Input => "input",
            Direction::Output => "output",
        }
    }
}

pub fn list() -> Result<Value, ProtoError> {
    let mut hosts = Vec::new();
    let mut devices = Vec::new();
    for host_id in cpal::available_hosts() {
        let host_key = host_id.to_string();
        let host = match cpal::host_from_id(host_id) {
            Ok(host) => host,
            Err(error) => {
                hosts.push(json!({
                    "id": host_key,
                    "name": host_id.name(),
                    "available": false,
                    "error": error.to_string(),
                }));
                continue;
            }
        };
        hosts.push(json!({
            "id": host_key,
            "name": host_id.name(),
            "available": true,
        }));
        let default_input = host.default_input_device().and_then(|d| d.id().ok());
        let default_output = host.default_output_device().and_then(|d| d.id().ok());
        let all = match host.devices() {
            Ok(all) => all,
            Err(error) => {
                eprintln!("{} device enumeration failed: {error}", host_id.name());
                continue;
            }
        };
        for device in all {
            let Ok(id) = device.id() else { continue };
            let name = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| device.to_string());
            for direction in [Direction::Input, Direction::Output] {
                let supported = match direction {
                    Direction::Input => device.supports_input(),
                    Direction::Output => device.supports_output(),
                };
                if !supported {
                    continue;
                }
                let is_default = match direction {
                    Direction::Input => default_input.as_ref() == Some(&id),
                    Direction::Output => default_output.as_ref() == Some(&id),
                };
                if let Some(entry) =
                    describe(&device, direction, &host_key, &id.to_string(), &name, is_default)
                {
                    devices.push(entry);
                }
            }
        }
    }
    Ok(json!({ "hosts": hosts, "devices": devices }))
}

fn describe<D: DeviceTrait>(
    device: &D,
    direction: Direction,
    host: &str,
    id: &str,
    name: &str,
    is_default: bool,
) -> Option<Value> {
    let configs: Vec<SupportedStreamConfigRange> = match direction {
        Direction::Input => device.supported_input_configs().ok()?.collect(),
        Direction::Output => device.supported_output_configs().ok()?.collect(),
    };
    if configs.is_empty() {
        return None;
    }
    let default = match direction {
        Direction::Input => device.default_input_config().ok(),
        Direction::Output => device.default_output_config().ok(),
    };
    let max_channels = configs.iter().map(|c| c.channels()).max().unwrap_or(0);
    let mut rates: Vec<u32> = STANDARD_RATES
        .iter()
        .copied()
        .filter(|rate| {
            configs
                .iter()
                .any(|c| c.min_sample_rate() <= *rate && *rate <= c.max_sample_rate())
        })
        .collect();
    if let Some(default) = &default {
        if !rates.contains(&default.sample_rate()) {
            rates.push(default.sample_rate());
            rates.sort_unstable();
        }
    }
    let buffer = default
        .as_ref()
        .map(|d| d.buffer_size().clone())
        .or_else(|| configs.first().map(|c| *c.buffer_size()));
    let buffer = match buffer {
        Some(SupportedBufferSize::Range { min, max }) => json!({ "min": min, "max": max }),
        _ => Value::Null,
    };
    Some(json!({
        "id": id,
        "host": host,
        "name": name,
        "direction": direction.label(),
        "isDefault": is_default,
        "maxChannels": max_channels,
        "defaultChannels": default.as_ref().map(|d| d.channels()),
        "defaultSampleRate": default.as_ref().map(|d| d.sample_rate()),
        "sampleRates": rates,
        "bufferFrames": buffer,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_never_panics_and_has_the_expected_shape() {
        let value = list().expect("listing should not fail");
        assert!(value["hosts"].is_array());
        assert!(value["devices"].is_array());
        for device in value["devices"].as_array().unwrap() {
            assert!(device["id"].is_string());
            assert!(matches!(
                device["direction"].as_str(),
                Some("input") | Some("output")
            ));
        }
    }
}
