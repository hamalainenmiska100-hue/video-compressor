# Turbo Compressor v2

Background-friendly file compressor for Fly.io with a modern dark UI.

## What's new in v2
- Background jobs: upload once, get a job ID, and let the server keep working.
- Real progress polling from FFmpeg progress output.
- Drag-and-drop upload UI.
- Recent jobs queue saved in `localStorage` so the browser can recover job cards later.
- Snackbars for success, warnings, and errors.
- Web Haptics integration for meaningful UI moments.
- Blue non-gradient button theme with a pressed-in interaction style.
- Download endpoints for finished jobs.
- Integrity hashes for original and compressed outputs.

## What it compresses
- Video: H.264 + AAC, optional exact target-size mode with two-pass encoding.
- Audio: AAC.
- Images: WebP or PNG.
- Generic files: gzip.

## Honest limitation
No encoder can guarantee that every 1.2 GB source becomes 200 MB while looking literally identical. This app gives you practical controls to chase that result:
- 1080p cap support
- up to 60 fps output
- CRF quality mode
- target-size mode for hard caps

## Local dev
```bash
npm install
npm run dev
```

Frontend: http://localhost:5173  
Backend: http://localhost:3000

## Deploy to Fly.io
This project is already set up for Dockerfile-based deployment.

### UI deploy flow
1. Push this project to GitHub.
2. In Fly.io, create a new app from the repo.
3. Let Fly use the `Dockerfile` in the project root.
4. Expose port `3000`.
5. Deploy.

### CLI deploy flow
```bash
fly launch
fly deploy
```

## Background-job note
The current queue is in-process and stores job files on local disk. That means it keeps working if the user closes the tab, but it is not a distributed queue yet. For a bigger production setup, add Redis/BullMQ plus object storage.
