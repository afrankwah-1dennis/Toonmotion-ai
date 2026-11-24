# ToonMotion AI — automatic free-first video engine

This backend now uses **automatic provider selection with a free-first policy**:

1. **ComfyUI running on your own GPU computer** is selected first. There is no per-video API charge, but you need compatible hardware, model files, electricity and setup time.
2. **fal is an optional paid fallback** and is disabled by default. The owner must deliberately set `ENABLE_PAID_PROVIDER=true` and add `FAL_KEY` before it can be used.
3. If neither is available, the app explains what is missing instead of silently spending money.

A free model does not mean free cloud computing. Self-hosting video models can require a powerful NVIDIA GPU and substantial storage. Wan 2.2 is one possible open-weight starting point; check its current model requirements and licence before deployment. See the model and ComfyUI links below.

## What this stage does

- Serves the ToonMotion Studio from `public/index.html`.
- Accepts a character reference image and scene prompt.
- Automatically chooses the local ComfyUI workflow first, or an explicitly enabled paid fal fallback.
- Polls scene jobs and proxies ComfyUI output video to the browser.
- Keeps provider API keys on the server.

It is **not yet a complete 5–15 minute episode pipeline**. Episode stitching, durable project storage, user accounts, character-reference management, audio generation, dialogue/lip-sync, moderation and quotas still need implementation.

## Setup (technical operator)

1. Install Node.js 20 or newer.
2. Install ComfyUI on a computer with a compatible GPU. Install an image-to-video model and workflow. Wan 2.2 is one open-weight option: https://github.com/Wan-Video/Wan2.2 . ComfyUI: https://github.com/comfyanonymous/ComfyUI .
3. In ComfyUI, load and test the image-to-video workflow. Export it using **Save (API Format)** and save the JSON as `workflow.json` in this backend folder.
4. In that workflow JSON, replace the text prompt value with the exact string `__PROMPT__`. Replace the Load Image node's image value with `__IMAGE_FILENAME__`. If needed, use `__IMAGE_SUBFOLDER__` and `__IMAGE_TYPE__` for the other image fields. Keep the workflow's output node configured to save a video (video/gif output), not just a still image.
5. Copy `.env.example` to `.env`. Set `COMFYUI_URL` to the ComfyUI address reachable by this Node server. If both run on the same computer, `http://127.0.0.1:8188` is typical. Set `COMFYUI_WORKFLOW=workflow.json`.
6. Install and start:

   ```bash
   npm install
   npm start
   ```

7. Open `http://localhost:3000`. `/api/health` reports which provider is selected.

## Optional paid fallback

To deliberately allow fal when local ComfyUI is unavailable, set `ENABLE_PAID_PROVIDER=true` and add `FAL_KEY`. This can incur charges. Leave it `false` for a strict free-first setup. Never put provider keys in the HTML or share them publicly.

## Important network note

If the backend is deployed to a cloud host, `127.0.0.1` refers to that cloud server, not your phone or home computer. The ComfyUI machine must be reachable securely from the backend. Do not expose ComfyUI's port directly to the public internet; use a private network or secure tunnel and restrict access.

## Current limitations

- The ComfyUI API workflow must be exported in API format and use the placeholders described above.
- The workflow must return a video output for this UI to preview it as a video.
- Generation time and quality depend on the selected model and GPU.
- Free self-hosting is not unlimited free cloud service; hardware and electricity are still required.
