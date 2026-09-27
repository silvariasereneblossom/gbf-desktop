/* global gbfRec */
// Recorder page logic. Exposes pickMime / startRecording / stopRecording for main to call.

// MP4 first (shares directly to Discord/Twitter), WebM as the universal fallback.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

let rec = null;
let stream = null;
let queue = Promise.resolve(); // serialize chunk hand-off so bytes reach disk in order

window.pickMime = () => MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || '';

window.startRecording = async (opts) => {
  if (rec && rec.state !== 'inactive') throw new Error('already recording');
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: opts.fps, max: opts.fps } },
    audio: !!opts.audio
  });
  rec = new MediaRecorder(stream, {
    mimeType: opts.mime || undefined,
    videoBitsPerSecond: opts.vbps,
    audioBitsPerSecond: 160000,
    // Chromium's MP4 muxer only emits a fragment at a keyframe; without this a mostly-static
    // game screen can go minutes between keyframes, so the whole recording piles up in memory
    // until stop. A keyframe every 2s keeps data flowing to disk (and makes the file scrubbable).
    videoKeyFrameIntervalDuration: 2000
  });
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    queue = queue.then(async () => gbfRec.chunk(new Uint8Array(await e.data.arrayBuffer())));
  };
  rec.onstop = () => {
    queue.then(() => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null;
      gbfRec.stopped();
    });
  };
  rec.onerror = (e) => gbfRec.error(String((e && e.error && e.error.message) || e));
  // The captured page going away (quit, account switch, view rebuilt) ends the track: finalize cleanly.
  stream.getVideoTracks()[0].addEventListener('ended', () => { if (rec && rec.state !== 'inactive') rec.stop(); });
  rec.start(1000); // 1s timeslices → at most ~1s lost on a hard crash
  const v = stream.getVideoTracks()[0].getSettings();
  return { mime: rec.mimeType, width: v.width, height: v.height, fps: v.frameRate, audioTracks: stream.getAudioTracks().length };
};

window.stopRecording = () => {
  if (rec && rec.state !== 'inactive') { rec.stop(); return true; }
  return false;
};
