import type { DeviceState, MediaInfo } from './types';
export function mediaScore(media: MediaInfo): number;
export function selectMedia(states: Array<DeviceState | undefined>): MediaInfo | undefined;
