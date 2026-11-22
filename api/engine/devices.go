package engine

import "context"

type HostInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Error     string `json:"error"`
}

type BufferRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type Device struct {
	ID                string       `json:"id"`
	Host              string       `json:"host"`
	Name              string       `json:"name"`
	Direction         string       `json:"direction"`
	IsDefault         bool         `json:"isDefault"`
	MaxChannels       int          `json:"maxChannels"`
	DefaultChannels   *int         `json:"defaultChannels"`
	DefaultSampleRate *int         `json:"defaultSampleRate"`
	SampleRates       []int        `json:"sampleRates"`
	BufferFrames      *BufferRange `json:"bufferFrames"`
}

type DeviceList struct {
	Hosts   []HostInfo `json:"hosts"`
	Devices []Device   `json:"devices"`
}

func (s *Supervisor) ListDevices(ctx context.Context) (DeviceList, error) {
	var list DeviceList
	if err := s.Call(ctx, "list_devices", nil, &list); err != nil {
		return DeviceList{}, err
	}
	if list.Hosts == nil {
		list.Hosts = []HostInfo{}
	}
	if list.Devices == nil {
		list.Devices = []Device{}
	}
	return list, nil
}
