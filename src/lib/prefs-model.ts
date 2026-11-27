export interface PreferenceValues {
  glass: string;
  corners: string;
  tooltips: boolean;
  tooltipDelayMs: number;
  peakHoldMs: number;
  reductionBars: boolean;
  faderStepDb: number;
  seekSeconds: number;
  seekLargeSeconds: number;
  speedStep: number;
  restartAfterSeconds: number;
  defaultSnap: string;
  beatGrid: boolean;
  tempoStep: number;
  tempoStepLarge: number;
  librarySort: string;
  artwork: boolean;
  playOnLoad: boolean;
  downloadChoice: string;
  checkUpdates: boolean;
}

export const FALLBACK_PREFERENCES: PreferenceValues = {
  glass: "full",
  corners: "rounded",
  tooltips: true,
  tooltipDelayMs: 450,
  peakHoldMs: 1200,
  reductionBars: true,
  faderStepDb: 0.5,
  seekSeconds: 5,
  seekLargeSeconds: 15,
  speedStep: 5,
  restartAfterSeconds: 3,
  defaultSnap: "beat",
  beatGrid: true,
  tempoStep: 1,
  tempoStepLarge: 5,
  librarySort: "added",
  artwork: true,
  playOnLoad: false,
  downloadChoice: "last",
  checkUpdates: true,
};

export const DOWNLOAD_CHOICES = [
  { value: "mp3:best", label: "MP3 audio, best quality" },
  { value: "mp3:320", label: "MP3 audio, 320 kbps" },
  { value: "mp3:256", label: "MP3 audio, 256 kbps" },
  { value: "mp3:192", label: "MP3 audio, 192 kbps" },
  { value: "mp3:128", label: "MP3 audio, 128 kbps" },
  { value: "mp4:best", label: "MP4 video, best quality" },
  { value: "mp4:1080", label: "MP4 video, 1080p" },
  { value: "mp4:720", label: "MP4 video, 720p" },
  { value: "mp4:480", label: "MP4 video, 480p" },
  { value: "mp4:360", label: "MP4 video, 360p" },
];

export function downloadDefault(preference: string, last: string | null): string {
  const known = (value: string | null) => DOWNLOAD_CHOICES.some((c) => c.value === value);
  if (preference !== "last" && known(preference)) return preference;
  return last !== null && known(last) ? last : DOWNLOAD_CHOICES[0].value;
}
