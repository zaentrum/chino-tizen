// The on-screen subtitles of a text track (WebVTT or SRT), drawn by the player
// screen itself. AVPlay hands an app subtitle text instead of drawing it, and a
// .srt sidecar cannot ride a native <track>, so text subtitles are drawn here,
// the same on both engines: the track's cue file is fetched once, parsed
// (@/lib/subtitles), and the cues under the playhead are shown. The cue box
// sits above the control bar while that is up.

import { useEffect, useMemo, useState } from 'react';
import { cueTextAt, parseSubtitleCues, type Cue } from '@/lib/subtitles';

interface SubtitleOverlayProps {
  /** The active text track's cue file (absolute, with the stream token);
   *  null when subtitles are off or the active track is drawn elsewhere. */
  url: string | null;
  /** The playhead, in seconds. */
  time: number;
  /** Raise the cues above the control bar (it is on screen). */
  lifted: boolean;
}

export function SubtitleOverlay({ url, time, lifted }: SubtitleOverlayProps): JSX.Element | null {
  const [cues, setCues] = useState<Cue[]>([]);

  useEffect(() => {
    setCues([]);
    if (!url) return undefined;
    // A flag rather than an AbortController: older TV engines lack it.
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (!cancelled) setCues(text ? parseSubtitleCues(text) : []);
      })
      .catch(() => {
        /* unreachable track: no subtitles rather than a broken player */
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const text = useMemo(() => cueTextAt(cues, time), [cues, time]);
  if (!url || !text) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10 flex justify-center px-24 transition-[bottom] duration-300"
      style={{ bottom: lifted ? '17rem' : '5rem' }}
      aria-live="off"
    >
      <div className="max-w-[80%] whitespace-pre-line bg-black/75 px-5 py-2 text-center text-4xl font-medium leading-snug text-white">
        {text}
      </div>
    </div>
  );
}

export default SubtitleOverlay;
