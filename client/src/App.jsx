import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWebHaptics } from 'web-haptics/react';

const SETTINGS_KEY = 'compressor-settings-v2';
const JOB_IDS_KEY = 'compressor-job-ids-v2';

const defaultSettings = {
  videoHeight: 1080,
  videoFps: 60,
  keepOriginalFps: true,
  crf: 22,
  preset: 'slow',
  tune: 'film',
  audioBitrateK: 128,
  targetSizeMB: 200,
  outputFormat: 'mp4',
  imageQuality: 82,
  enableHaptics: true,
  autoDownload: true
};

const presetCards = [
  {
    id: 'balanced',
    label: 'Balanced 1080p',
    blurb: 'Good default for most uploads.',
    values: {
      targetSizeMB: 200,
      videoHeight: 1080,
      keepOriginalFps: true,
      videoFps: 60,
      crf: 22,
      preset: 'slow',
      tune: 'film',
      audioBitrateK: 128,
      outputFormat: 'mp4'
    }
  },
  {
    id: 'smaller',
    label: 'Smaller file',
    blurb: 'Tighter size target and slower encode.',
    values: {
      targetSizeMB: 120,
      videoHeight: 1080,
      keepOriginalFps: false,
      videoFps: 60,
      crf: 24,
      preset: 'slower',
      tune: 'fastdecode',
      audioBitrateK: 96,
      outputFormat: 'mp4'
    }
  },
  {
    id: 'detail',
    label: 'Preserve detail',
    blurb: 'Bigger file, cleaner image.',
    values: {
      targetSizeMB: 0,
      videoHeight: 1080,
      keepOriginalFps: true,
      videoFps: 60,
      crf: 20,
      preset: 'slow',
      tune: 'grain',
      audioBitrateK: 160,
      outputFormat: 'mp4'
    }
  },
  {
    id: 'share',
    label: 'Quick share',
    blurb: 'Fast and lighter for messaging.',
    values: {
      targetSizeMB: 60,
      videoHeight: 720,
      keepOriginalFps: false,
      videoFps: 30,
      crf: 26,
      preset: 'medium',
      tune: 'fastdecode',
      audioBitrateK: 96,
      outputFormat: 'mp4'
    }
  }
];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function SnackbarStack({ items, onDismiss }) {
  return (
    <div className="snackbarStack" aria-live="polite" aria-atomic="true">
      {items.map((item) => (
        <div key={item.id} className={`snackbar snackbar-${item.tone}`}>
          <div>
            <strong>{item.title}</strong>
            {item.message ? <p>{item.message}</p> : null}
          </div>
          <button type="button" className="iconButton" onClick={() => onDismiss(item.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const inputRef = useRef(null);
  const draggedOver = useRef(false);
  const downloadedDoneJobs = useRef(new Set());
  const pollerRef = useRef(null);
  const snackbarTimers = useRef(new Map());
  const { trigger } = useWebHaptics();

  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [jobs, setJobs] = useState([]);
  const [snackbars, setSnackbars] = useState([]);
  const [creatingJob, setCreatingJob] = useState(false);

  const activeJobs = useMemo(
    () => jobs.filter((job) => job.status === 'queued' || job.status === 'processing'),
    [jobs]
  );

  const latestDone = useMemo(
    () => jobs.find((job) => job.status === 'done') || null,
    [jobs]
  );

  function fireHaptic(type) {
    if (!settings.enableHaptics) return;
    try {
      trigger(type);
    } catch {}
  }

  function rememberJobId(id) {
    const ids = loadJson(JOB_IDS_KEY, []);
    const next = [id, ...ids.filter((value) => value !== id)].slice(0, 12);
    localStorage.setItem(JOB_IDS_KEY, JSON.stringify(next));
  }

  function forgetJobId(id) {
    const ids = loadJson(JOB_IDS_KEY, []);
    const next = ids.filter((value) => value !== id);
    localStorage.setItem(JOB_IDS_KEY, JSON.stringify(next));
  }

  function upsertJob(job) {
    setJobs((current) => {
      const without = current.filter((item) => item.id !== job.id);
      return [job, ...without].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    });
  }

  function removeJob(id) {
    setJobs((current) => current.filter((job) => job.id !== id));
    forgetJobId(id);
    downloadedDoneJobs.current.delete(id);
    fireHaptic('light');
  }

  function pushSnackbar(title, message = '', tone = 'info', duration = 3200) {
    const id = crypto.randomUUID();
    setSnackbars((current) => [...current, { id, title, message, tone }]);
    const timeoutId = window.setTimeout(() => {
      setSnackbars((current) => current.filter((item) => item.id !== id));
      snackbarTimers.current.delete(id);
    }, duration);
    snackbarTimers.current.set(id, timeoutId);
  }

  function dismissSnackbar(id) {
    const timeoutId = snackbarTimers.current.get(id);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      snackbarTimers.current.delete(id);
    }
    setSnackbars((current) => current.filter((item) => item.id !== id));
  }

  async function fetchJob(id) {
    const response = await fetch(`/api/jobs/${id}`);
    if (!response.ok) throw new Error('Could not load job status.');
    const job = await response.json();
    upsertJob(job);
    return job;
  }

  async function refreshKnownJobs() {
    const ids = loadJson(JOB_IDS_KEY, []);
    if (!ids.length) return;
    const settled = await Promise.allSettled(ids.map((id) => fetchJob(id)));
    settled.forEach((result) => {
      if (result.status === 'rejected') {
        pushSnackbar('Job status failed', result.reason?.message || 'Could not refresh one of your jobs.', 'warning', 2800);
      }
    });
  }

  useEffect(() => {
    const savedSettings = loadJson(SETTINGS_KEY, defaultSettings);
    setSettings({ ...defaultSettings, ...savedSettings });
    refreshKnownJobs().catch(() => {});

    return () => {
      for (const timeoutId of snackbarTimers.current.values()) {
        window.clearTimeout(timeoutId);
      }
      if (pollerRef.current) window.clearInterval(pollerRef.current);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (pollerRef.current) {
      window.clearInterval(pollerRef.current);
      pollerRef.current = null;
    }

    if (!activeJobs.length) return;

    pollerRef.current = window.setInterval(() => {
      activeJobs.forEach((job) => {
        fetchJob(job.id)
          .then((freshJob) => {
            if (freshJob.status === 'done') {
              pushSnackbar('Compression done', freshJob.outputName || freshJob.fileName, 'success', 3600);
              fireHaptic('success');
              if (settings.autoDownload && !downloadedDoneJobs.current.has(freshJob.id) && freshJob.downloadUrl) {
                downloadedDoneJobs.current.add(freshJob.id);
                window.location.href = freshJob.downloadUrl;
              }
            }
            if (freshJob.status === 'error') {
              pushSnackbar('Compression failed', freshJob.error || 'Something went wrong.', 'error', 4600);
              fireHaptic('error');
            }
          })
          .catch(() => {});
      });
    }, 1500);

    return () => {
      if (pollerRef.current) window.clearInterval(pollerRef.current);
      pollerRef.current = null;
    };
  }, [activeJobs, settings.autoDownload, settings.enableHaptics]);

  useEffect(() => {
    jobs.forEach((job) => {
      if (job.status === 'done' && settings.autoDownload && !downloadedDoneJobs.current.has(job.id) && job.downloadUrl) {
        downloadedDoneJobs.current.add(job.id);
      }
    });
  }, [jobs, settings.autoDownload]);

  function applyPreset(values) {
    setSettings((current) => ({ ...current, ...values }));
    fireHaptic('selection');
    pushSnackbar('Preset applied', 'The encoder settings were updated.', 'info', 1800);
  }

  function openPicker() {
    inputRef.current?.click();
  }

  function setChosenFile(nextFile) {
    if (!nextFile) return;
    setFile(nextFile);
    pushSnackbar('File ready', `${nextFile.name} · ${formatBytes(nextFile.size)}`, 'info', 2200);
  }

  async function handleCreateJob(event) {
    event.preventDefault();
    if (!file) {
      pushSnackbar('Pick a file first', 'Drop a file into the box or browse for one.', 'warning');
      fireHaptic('warning');
      return;
    }

    setCreatingJob(true);
    fireHaptic('medium');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('settings', JSON.stringify(settings));

      const response = await fetch('/api/jobs', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        let detail = 'Could not start the compression job.';
        try {
          const json = await response.json();
          detail = json.error || detail;
        } catch {}
        throw new Error(detail);
      }

      const job = await response.json();
      upsertJob(job);
      rememberJobId(job.id);
      pushSnackbar('Job started', 'You can leave the page and come back later.', 'success', 3000);
      setFile(null);
    } catch (error) {
      pushSnackbar('Job creation failed', error.message || 'Unknown error', 'error', 4600);
      fireHaptic('error');
    } finally {
      setCreatingJob(false);
    }
  }

  function onDrop(event) {
    event.preventDefault();
    draggedOver.current = false;
    setDragActive(false);
    const nextFile = event.dataTransfer?.files?.[0] || null;
    if (nextFile) setChosenFile(nextFile);
  }

  function onDragOver(event) {
    event.preventDefault();
    if (!draggedOver.current) {
      draggedOver.current = true;
      setDragActive(true);
    }
  }

  function onDragLeave(event) {
    event.preventDefault();
    if (event.currentTarget.contains(event.relatedTarget)) return;
    draggedOver.current = false;
    setDragActive(false);
  }

  return (
    <div className="page">
      <div className="shell">
        <header className="hero card">
          <div>
            <p className="eyebrow">Background file compression</p>
            <h1>Turbo Compressor</h1>
            <p className="lead">
              Queue a job, close the tab, and come back later. The server keeps processing in the background,
              while the browser keeps your settings, recent jobs, haptics, and auto-download behavior.
            </p>
          </div>
          <div className="heroMeta">
            <div className="statTile">
              <span>Theme</span>
              <strong>Dark + blue</strong>
            </div>
            <div className="statTile">
              <span>Workflow</span>
              <strong>Drag, queue, leave</strong>
            </div>
          </div>
        </header>

        <section className="grid topGrid">
          <form className="card stack" onSubmit={handleCreateJob}>
            <div className="sectionHeader">
              <div>
                <p className="sectionKicker">Upload</p>
                <h2>Drop a file and launch a job</h2>
              </div>
              <button type="button" className="ghostButton" onClick={openPicker}>
                Browse
              </button>
            </div>

            <div
              className={`dropzone ${dragActive ? 'dropzone-active' : ''}`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={openPicker}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openPicker();
                }
              }}
            >
              <input
                ref={inputRef}
                type="file"
                className="hiddenInput"
                onChange={(event) => setChosenFile(event.target.files?.[0] || null)}
              />
              <div className="dropIcon">↓</div>
              <strong>{file ? file.name : 'Drop any file here'}</strong>
              <p>{file ? formatBytes(file.size) : 'Video, image, audio, or generic files.'}</p>
              <small>Tap to browse or drag from your desktop.</small>
            </div>

            <div className="presetGrid">
              {presetCards.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="presetButton"
                  onClick={() => applyPreset(preset.values)}
                >
                  <strong>{preset.label}</strong>
                  <span>{preset.blurb}</span>
                </button>
              ))}
            </div>

            <button type="submit" className="primaryButton" disabled={creatingJob}>
              {creatingJob ? 'Starting job…' : 'Compress in background'}
            </button>
          </form>

          <section className="card stack settingsCard">
            <div className="sectionHeader">
              <div>
                <p className="sectionKicker">Settings</p>
                <h2>Client-side controls</h2>
              </div>
            </div>

            <div className="formGrid">
              <label>
                <span>Target size (MB)</span>
                <input
                  type="number"
                  min="0"
                  max="50000"
                  value={settings.targetSizeMB}
                  onChange={(event) => setSettings((current) => ({ ...current, targetSizeMB: Number(event.target.value) }))}
                />
              </label>

              <label>
                <span>Max height</span>
                <input
                  type="number"
                  min="144"
                  max="2160"
                  value={settings.videoHeight}
                  onChange={(event) => setSettings((current) => ({ ...current, videoHeight: Number(event.target.value) }))}
                />
              </label>

              <label>
                <span>FPS cap</span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  disabled={settings.keepOriginalFps}
                  value={settings.videoFps}
                  onChange={(event) => setSettings((current) => ({ ...current, videoFps: Number(event.target.value) }))}
                />
              </label>

              <label>
                <span>Audio bitrate (kbps)</span>
                <input
                  type="number"
                  min="32"
                  max="320"
                  value={settings.audioBitrateK}
                  onChange={(event) => setSettings((current) => ({ ...current, audioBitrateK: Number(event.target.value) }))}
                />
              </label>

              <label>
                <span>CRF</span>
                <input
                  type="range"
                  min="16"
                  max="36"
                  value={settings.crf}
                  onChange={(event) => setSettings((current) => ({ ...current, crf: Number(event.target.value) }))}
                />
                <small>{settings.crf}</small>
              </label>

              <label>
                <span>x264 preset</span>
                <select
                  value={settings.preset}
                  onChange={(event) => setSettings((current) => ({ ...current, preset: event.target.value }))}
                >
                  <option value="medium">medium</option>
                  <option value="slow">slow</option>
                  <option value="slower">slower</option>
                  <option value="veryslow">veryslow</option>
                </select>
              </label>

              <label>
                <span>Tune</span>
                <select
                  value={settings.tune}
                  onChange={(event) => setSettings((current) => ({ ...current, tune: event.target.value }))}
                >
                  <option value="film">film</option>
                  <option value="animation">animation</option>
                  <option value="grain">grain</option>
                  <option value="fastdecode">fastdecode</option>
                  <option value="zerolatency">zerolatency</option>
                </select>
              </label>

              <label>
                <span>Output format</span>
                <select
                  value={settings.outputFormat}
                  onChange={(event) => setSettings((current) => ({ ...current, outputFormat: event.target.value }))}
                >
                  <option value="mp4">mp4 / webp</option>
                  <option value="mkv">mkv</option>
                  <option value="png">png (images)</option>
                </select>
              </label>
            </div>

            <div className="toggleGrid">
              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={settings.keepOriginalFps}
                  onChange={(event) => setSettings((current) => ({ ...current, keepOriginalFps: event.target.checked }))}
                />
                <span>Keep original FPS up to 60</span>
              </label>

              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={settings.enableHaptics}
                  onChange={(event) => {
                    setSettings((current) => ({ ...current, enableHaptics: event.target.checked }));
                    if (event.target.checked) {
                      window.requestAnimationFrame(() => {
                        try {
                          trigger('selection');
                        } catch {}
                      });
                    }
                  }}
                />
                <span>Enable Web Haptics</span>
              </label>

              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={settings.autoDownload}
                  onChange={(event) => setSettings((current) => ({ ...current, autoDownload: event.target.checked }))}
                />
                <span>Auto-download when done</span>
              </label>
            </div>
          </section>
        </section>

        <section className="grid lowerGrid">
          <section className="card stack">
            <div className="sectionHeader">
              <div>
                <p className="sectionKicker">Queue</p>
                <h2>Recent jobs</h2>
              </div>
              {activeJobs.length ? <span className="badge">{activeJobs.length} active</span> : <span className="badge muted">Idle</span>}
            </div>

            {jobs.length ? (
              <div className="jobList">
                {jobs.map((job) => (
                  <article key={job.id} className="jobCard">
                    <div className="jobHeader">
                      <div>
                        <strong>{job.outputName || job.fileName}</strong>
                        <p>{job.stage || 'Queued'} · {job.kind}</p>
                      </div>
                      <div className="jobActions">
                        <span className={`statusPill status-${job.status}`}>{job.status}</span>
                        <button type="button" className="iconButton" onClick={() => removeJob(job.id)} aria-label="Remove job">
                          ×
                        </button>
                      </div>
                    </div>

                    <div className="progressWrap">
                      <div className="progressBar" style={{ width: `${job.progress || 0}%` }} />
                    </div>

                    <div className="jobMeta">
                      <span>{job.progress || 0}%</span>
                      <span>{formatTime(job.updatedAt)}</span>
                    </div>

                    {job.status === 'done' ? (
                      <div className="jobDetails">
                        <div>
                          <span>Original</span>
                          <strong>{formatBytes(job.originalBytes)}</strong>
                        </div>
                        <div>
                          <span>Compressed</span>
                          <strong>{formatBytes(job.compressedBytes)}</strong>
                        </div>
                        <div>
                          <span>Saved</span>
                          <strong>{Number.isFinite(job.reduction) ? `${job.reduction.toFixed(1)}%` : '—'}</strong>
                        </div>
                      </div>
                    ) : null}

                    {job.error ? <p className="errorText">{job.error}</p> : null}

                    <div className="jobFooter">
                      {job.downloadUrl ? (
                        <a
                          className="primaryButton smallButton"
                          href={job.downloadUrl}
                          onClick={() => fireHaptic('medium')}
                        >
                          Download
                        </a>
                      ) : (
                        <button type="button" className="secondaryButton smallButton" onClick={() => fetchJob(job.id)}>
                          Refresh
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="emptyState">
                <strong>No jobs yet</strong>
                <p>Start a compression job and it will show up here.</p>
              </div>
            )}
          </section>

          <section className="card stack">
            <div className="sectionHeader">
              <div>
                <p className="sectionKicker">Result</p>
                <h2>Latest completed file</h2>
              </div>
            </div>

            {latestDone ? (
              <>
                <div className="resultHero">
                  <strong>{latestDone.outputName}</strong>
                  <p>{latestDone.fileName}</p>
                </div>
                <div className="jobDetails compact">
                  <div>
                    <span>Original</span>
                    <strong>{formatBytes(latestDone.originalBytes)}</strong>
                  </div>
                  <div>
                    <span>Compressed</span>
                    <strong>{formatBytes(latestDone.compressedBytes)}</strong>
                  </div>
                  <div>
                    <span>Reduction</span>
                    <strong>{Number.isFinite(latestDone.reduction) ? `${latestDone.reduction.toFixed(1)}%` : '—'}</strong>
                  </div>
                </div>
                <a className="primaryButton" href={latestDone.downloadUrl} onClick={() => fireHaptic('medium')}>
                  Download latest result
                </a>
                <details className="hashPanel">
                  <summary>Integrity hashes</summary>
                  <p><strong>Original SHA-256</strong><br />{latestDone.originalSha256}</p>
                  <p><strong>Compressed SHA-256</strong><br />{latestDone.compressedSha256}</p>
                </details>
              </>
            ) : (
              <div className="emptyState alt">
                <strong>Nothing finished yet</strong>
                <p>Once a job completes, its download card will appear here automatically.</p>
              </div>
            )}
          </section>
        </section>
      </div>

      <SnackbarStack items={snackbars} onDismiss={dismissSnackbar} />
    </div>
  );
}
