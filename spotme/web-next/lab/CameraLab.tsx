/**
 * Camera Lab — the owner's Stage 2B device-validation cockpit. LAB-ONLY:
 * built solely when CAMERA_LAB_ENABLED=true; never routed, linked, or in
 * the production artifact (fence-proven). Exercises the real engines on a
 * real phone and produces a COPYABLE MARKDOWN results block the owner
 * pastes back (attachments don't transfer).
 *
 * Safety surfaces the C5 review named: a VISIBLE recording-state indicator
 * while a track is live; scan payloads rendered as UNTRUSTED plain text
 * (never auto-opened); labeled controls + live regions for basic a11y.
 */

import { useCallback, useRef, useState } from 'react';
import { createCameraEngine } from '../src/camera/engine';
import { applyBeauty } from '../src/camera/ar';
import type { CaptureKind } from '@spotme/contracts';
import type { CameraDevicePort } from '../src/camera/engine';
import type { RgbaImage } from '../src/camera/types';
import {
  createNavigatorDevicePort, wireFaceLandmarker, wireScanner, wireTesseract,
} from './wirings';

type Row = { feature: string; result: string; ms: number | null; note: string };

function nowMs(): number { return performance.now(); }

function rgbaToDataUrl(image: RgbaImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  const buf = new Uint8ClampedArray(image.data); // ArrayBuffer-backed copy
  ctx.putImageData(new ImageData(buf, image.width, image.height), 0, 0);
  return canvas.toDataURL('image/png');
}

export function CameraLab() {
  const deviceRef = useRef<CameraDevicePort | null>(null);
  const [recording, setRecording] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [beauty, setBeauty] = useState({ smooth: 0.4, tone: 0.2, brighten: 0.2 });
  const [scanText, setScanText] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [thermal, setThermal] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [status, setStatus] = useState('Idle. Grant camera permission to begin.');

  const device = useCallback(() => {
    if (!deviceRef.current) deviceRef.current = createNavigatorDevicePort();
    return deviceRef.current;
  }, []);

  const record = useCallback((feature: string, result: string, ms: number | null, note = '') => {
    setRows((r) => [...r.filter((x) => x.feature !== feature), { feature, result, ms, note }]);
  }, []);

  const capture = useCallback(async (kind: CaptureKind) => {
    setStatus(`Capturing ${kind}…`);
    setRecording(true);
    const engine = createCameraEngine(device());
    const t = nowMs();
    const result = await engine.capture({ kind, facing: 'environment' });
    const ms = Math.round(nowMs() - t);
    setRecording(false);
    if (result.state === 'captured') {
      record(kind, 'captured', ms);
      setStatus(`${kind}: captured in ${ms} ms`);
    } else if (result.state === 'captured-burst') {
      record(kind, `captured ${result.media.length} frames`, ms);
      setStatus(`${kind}: ${result.media.length} frames in ${ms} ms`);
    } else {
      record(kind, `unavailable: ${result.reason}`, ms, 'honest refusal');
      setStatus(`${kind}: unavailable — ${result.reason} (this is honest, not a failure)`);
    }
  }, [device, record]);

  const previewBeauty = useCallback(async () => {
    setRecording(true);
    const engine = createCameraEngine(device());
    const shot = await engine.capture({ kind: 'still' });
    setRecording(false);
    if (shot.state !== 'captured') { setStatus('No frame to beautify.'); return; }
    // Re-grab raw pixels for the preview (the engine returns a ref only).
    const dev = device();
    const opened = await dev.open({ facing: 'user' });
    if (opened.state !== 'open') { setStatus('Camera unavailable for preview.'); return; }
    setRecording(true);
    const frame = await dev.grabFrame(opened.sessionId);
    await dev.release(opened.sessionId);
    setRecording(false);
    if (!frame) { setStatus('No pixels for preview.'); return; }
    const t = nowMs();
    const out = applyBeauty(frame.image, { tier: 'tier-0', params: beauty }, false);
    const ms = Math.round(nowMs() - t);
    if ('data' in out) { setPreview(rgbaToDataUrl(out)); record('beauty tier-0', 'applied', ms); setStatus(`Beauty applied in ${ms} ms`); }
  }, [device, beauty, record]);

  const runScan = useCallback(async () => {
    setRecording(true);
    const dev = device();
    const opened = await dev.open({ facing: 'environment' });
    if (opened.state !== 'open') { setRecording(false); setStatus('Camera unavailable for scan.'); return; }
    const frame = await dev.grabFrame(opened.sessionId);
    await dev.release(opened.sessionId);
    setRecording(false);
    if (!frame) { setStatus('No frame for scan.'); return; }
    const scanner = wireScanner();
    const t = nowMs();
    const result = await scanner.scan(frame.image);
    const ms = Math.round(nowMs() - t);
    if (result.state === 'detected') {
      setScanText(result.detections[0].rawValue); // UNTRUSTED — rendered as text, never opened
      record('barcode/QR', `${result.detections[0].format} via ${result.detections[0].decoder}`, ms);
    } else {
      setScanText(null);
      record('barcode/QR', result.state === 'none' ? 'nothing found' : `unavailable: ${result.reason}`, ms);
    }
  }, [device, record]);

  const runFaces = useCallback(async () => {
    setStatus('Loading face landmarker (verifying integrity)…');
    const t0 = nowMs();
    const { tracker, registration } = await wireFaceLandmarker();
    const regNote = 'state' in registration && registration.state === 'registered' ? 'landmarker registered' : `refused: ${'reason' in registration ? registration.reason : 'unknown'}`;
    const dev = device();
    const opened = await dev.open({ facing: 'user' });
    if (opened.state !== 'open') { setStatus('Camera unavailable for faces.'); return; }
    setRecording(true);
    const frame = await dev.grabFrame(opened.sessionId);
    await dev.release(opened.sessionId);
    setRecording(false);
    if (!frame) { setStatus('No frame for faces.'); return; }
    const tracked = await tracker.track(frame.image);
    const ms = Math.round(nowMs() - t0);
    record('face tracking', tracked.state === 'tracked' ? `${tracked.faces.length} face(s); ${regNote}` : `unavailable: ${tracked.reason}`, ms, regNote);
    setStatus(`Faces: ${tracked.state} (${regNote})`);
  }, [device, record]);

  const runOcr = useCallback(async (language: 'eng' | 'kan') => {
    setStatus(`Loading tesseract (${language})…`);
    const dev = device();
    const opened = await dev.open({ facing: 'environment' });
    if (opened.state !== 'open') { setStatus('Camera unavailable for OCR.'); return; }
    setRecording(true);
    const frame = await dev.grabFrame(opened.sessionId);
    await dev.release(opened.sessionId);
    setRecording(false);
    if (!frame) { setStatus('No frame for OCR.'); return; }
    const ocr = wireTesseract(language);
    const t = nowMs();
    await ocr.load();
    const result = await ocr.recognize(frame.image);
    const ms = Math.round(nowMs() - t);
    if (result.state === 'recognized') { setOcrText(result.text); record(`OCR (${language})`, result.text ? 'text read' : 'empty (honest)', ms); }
    else { setOcrText(null); record(`OCR (${language})`, `unavailable: ${result.reason}`, ms); }
    setStatus(`OCR ${language}: ${result.state}`);
  }, [device, record]);

  const markdown = [
    `## Camera Stage 2B — device results`,
    ``,
    `- **Device:** ${deviceLabel || '(fill in: model / OS / browser)'}`,
    `- **Thermal/battery note:** ${thermal || '(fill in)'}`,
    ``,
    `| Feature | Result | ms | Note |`,
    `|---|---|---|---|`,
    ...rows.map((r) => `| ${r.feature} | ${r.result} | ${r.ms ?? ''} | ${r.note} |`),
  ].join('\n');

  return (
    <main className="lab" aria-label="Camera device lab">
      <h1>Camera Lab (Stage 2B)</h1>
      <p role="status" aria-live="polite" className="lab-status">{status}</p>

      {recording && (
        <p className="lab-rec" role="alert" aria-live="assertive">
          <span className="lab-rec-dot" aria-hidden="true" /> Camera is active
        </p>
      )}

      <section aria-label="Capture">
        <h2>Capture</h2>
        {(['still', 'hdr', 'night', 'burst', 'video'] as CaptureKind[]).map((k) => (
          <button key={k} className="lab-btn" onClick={() => void capture(k)}>{k}</button>
        ))}
      </section>

      <section aria-label="Beauty preview">
        <h2>Beauty tier-0</h2>
        {(['smooth', 'tone', 'brighten'] as const).map((key) => (
          <label key={key} className="lab-slider">
            {key}
            <input type="range" min={0} max={1} step={0.05} value={beauty[key]}
              onChange={(e) => setBeauty((b) => ({ ...b, [key]: Number(e.target.value) }))} />
          </label>
        ))}
        <button className="lab-btn" onClick={() => void previewBeauty()}>preview beauty</button>
        {preview && <img className="lab-preview" src={preview} alt="Beauty preview" />}
      </section>

      <section aria-label="Face landmarks">
        <h2>Face landmark overlay</h2>
        <button className="lab-btn" onClick={() => void runFaces()}>detect faces</button>
      </section>

      <section aria-label="Barcode and QR scan">
        <h2>Barcode / QR</h2>
        <button className="lab-btn" onClick={() => void runScan()}>scan</button>
        {scanText !== null && (
          <p className="lab-untrusted">
            Scanned (untrusted — not a link): <code>{scanText}</code>
          </p>
        )}
      </section>

      <section aria-label="Text recognition">
        <h2>OCR</h2>
        <button className="lab-btn" onClick={() => void runOcr('eng')}>OCR (eng)</button>
        <button className="lab-btn" onClick={() => void runOcr('kan')}>OCR (kan)</button>
        {ocrText !== null && <pre className="lab-ocr">{ocrText || '(empty read — honest)'}</pre>}
      </section>

      <section aria-label="Results checklist">
        <h2>Results (copy this to the session)</h2>
        <label className="lab-field">Device model / OS / browser
          <input value={deviceLabel} onChange={(e) => setDeviceLabel(e.target.value)} />
        </label>
        <label className="lab-field">Thermal / battery note
          <input value={thermal} onChange={(e) => setThermal(e.target.value)} />
        </label>
        <textarea className="lab-md" readOnly value={markdown} aria-label="Copyable markdown results" rows={12} />
      </section>
    </main>
  );
}
