/**
 * Reusable live camera capture. Requires HTTPS (or localhost) and user
 * permission. facingMode: 'environment' for back camera (ID documents),
 * 'user' for front camera (selfies).
 */
function createCameraCapture({ videoEl, canvasEl, facingMode }) {
  let stream = null;

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 720 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  function capture() {
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    canvasEl.width = w;
    canvasEl.height = h;
    const ctx = canvasEl.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, w, h);
    stop();
    return canvasEl.toDataURL('image/jpeg', 0.85);
  }

  return { start, stop, capture };
}
