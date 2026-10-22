// ============================================================
// ScreenshotTool.js — PlayCanvas Script
// Screenshot scene → upload Cloudinary → SearchAPI Lens → sidebar
// ============================================================

var ScreenshotTool = pc.createScript("screenshotTool");

ScreenshotTool.attributes.add("buttonPosition", {
  type: "string",
  default: "bottom-left",
  title: "Button Position",
});

ScreenshotTool.attributes.add("cloudinaryCloudName", {
  type: "string",
  default: "YOUR_CLOUD_NAME",
  title: "Cloudinary Cloud Name",
});

ScreenshotTool.attributes.add("cloudinaryUploadPreset", {
  type: "string",
  default: "YOUR_UPLOAD_PRESET",
  title: "Cloudinary Upload Preset",
});

ScreenshotTool.attributes.add("searchApiKey", {
  type: "string",
  default: "YOUR_SEARCHAPI_KEY",
  title: "SearchAPI Key",
});

ScreenshotTool.attributes.add("cameraEntity", {
  type: "entity",
  title: "Player Camera Entity",
  description:
    "The primary camera entity that will be rotation-locked during screenshot selection.",
});

ScreenshotTool.prototype.initialize = function () {
  this._selecting = false;
  this._startX = 0;
  this._startY = 0;

  this._injectStyles();
  this._buildUI();

  // When any OTHER tool becomes active, disable this one so only a
  // single tool is ever active at a time.
  var self = this;

  this._toolActivateHandler = function (event) {
    if (event && event.detail && event.detail.tool !== "screenshot") {
      self._cancelCapture();

      var panel = document.getElementById("sstPanel");
      if (panel) {
        panel.classList.remove("open");
      }
    }
  };

  window.addEventListener("vroomk:activate-tool", this._toolActivateHandler);

  console.log("[ScreenshotTool] Ready");
};

ScreenshotTool.prototype._injectStyles = function () {
  if (document.getElementById("sst-style")) return;

  var s = document.createElement("style");
  s.id = "sst-style";

  s.textContent = `
#sst-btn {
    position: fixed;
    z-index: 2147483640;
    height: 46px;
    padding: 0 16px;
    gap: 8px;
    border-radius: 12px;
    background: rgba(13,15,20,0.9);
    border: 1px solid rgba(255,255,255,0.15);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
    white-space: nowrap;
    transition: 0.15s ease;
}
#sst-btn:hover {
    background: rgba(13,15,20,0.95);
    border-color: rgba(47,123,255,0.5);
}
#sst-btn.bottom-left { bottom: 24px; left: 24px; }
#sst-btn.bottom-right { bottom: 24px; right: 24px; }
#sst-btn.top-left { top: 24px; left: 24px; }
#sst-btn.top-right { top: 24px; right: 24px; }

#sst-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483641;
    cursor: crosshair;
    display: none;
    user-select: none;
}
#sst-overlay.active { display: block; }

#sst-mask-top,
#sst-mask-bottom,
#sst-mask-left,
#sst-mask-right {
    position: absolute;
    background: rgba(0,0,0,0.52);
}

#sst-sel {
    position: absolute;
    border: 2px solid #2f7bff;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5);
    display: none;
    pointer-events: none;
}

#sst-sizelabel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    background: rgba(13,15,20,0.95);
    color: #5ba3ff;
    font-size: 11px;
    font-family: system-ui, sans-serif;
    font-weight: 700;
    padding: 4px 8px;
    border-radius: 5px;
    white-space: nowrap;
}

#sst-instruct {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483642;
    padding: 10px 20px;
    background: rgba(13,15,20,0.95);
    color: rgba(255,255,255,0.75);
    border-radius: 20px;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    display: none;
}

#sst-flash {
    position: fixed;
    inset: 0;
    background: white;
    z-index: 2147483643;
    opacity: 0;
    pointer-events: none;
}
#sst-flash.pop { opacity: 0.35; }

#sst-toast {
    position: fixed;
    right: 28px;
    bottom: 28px;
    z-index: 2147483644;
    padding: 11px 16px;
    background: rgba(13,15,20,0.95);
    color: #4ade80;
    border: 1px solid rgba(34,197,94,0.35);
    border-radius: 10px;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    opacity: 0;
    transform: translateY(6px);
    transition: 0.2s;
}
#sst-toast.show {
    opacity: 1;
    transform: translateY(0);
}

#sstPanel {
    position: fixed;
    top: 0;
    right: 0;
    width: 340px;
    height: 100vh;
    background: #0d0f14;
    border-left: 1px solid rgba(255,255,255,0.1);
    z-index: 2147483639;
    transform: translateX(100%);
    transition: transform 0.28s ease;
    font-family: system-ui, sans-serif;
    color: white;
    display: flex;
    flex-direction: column;
    overflow: visible;
}
#sstPanel.open { transform: translateX(0); }

#sstPanelHeader {
    padding: 18px 16px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    background: #13161e;
    position: relative;
}
#sstPanelTitle {
    font-size: 16px;
    font-weight: 800;
}
#sstPanelSubtitle {
    font-size: 11px;
    color: rgba(255,255,255,0.42);
    margin-top: 3px;
}
#sstPanelClose {
    position: absolute;
    top: 50%;
    left: -34px;
    width: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px 8px;
    color: rgba(255,255,255,0.55);
    background: #13161e;
    border: 1px solid rgba(255,255,255,0.1);
    border-right: 0;
    border-radius: 10px 0 0 10px;
    box-shadow: -4px 0 16px rgba(0,0,0,0.3);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-50%);
    transition: color 0.15s ease, background 0.15s ease, opacity 0.2s ease;
}
#sstPanel.open #sstPanelClose {
    opacity: 1;
    pointer-events: auto;
}
#sstPanelClose:hover {
    color: #ffffff;
    background: #1a1e28;
}
#sstPanelClose svg {
    display: block;
    pointer-events: none;
}

#sstPreviewWrap {
    margin: 14px 16px 0;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.1);
    display: none;
}
#sstPreview {
    width: 100%;
    max-height: 115px;
    object-fit: cover;
    display: block;
}

#sstState {
    padding: 28px 20px;
    color: rgba(255,255,255,0.45);
    font-size: 13px;
    text-align: center;
    line-height: 1.6;
}

.sst-spinner {
    width: 34px;
    height: 34px;
    margin: 0 auto 12px;
    border: 3px solid rgba(255,255,255,0.08);
    border-top-color: #2f7bff;
    border-radius: 50%;
    animation: sstSpin 0.7s linear infinite;
}
@keyframes sstSpin {
    to { transform: rotate(360deg); }
}

#sstScroll {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px 20px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px 14px;
    align-content: start;
}
#sstScroll::-webkit-scrollbar { width: 4px; }
#sstScroll::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.16);
    border-radius: 10px;
}

.sst-card {
    display: flex;
    flex-direction: column;
    text-decoration: none;
    gap: 8px;
    background: transparent;
    border: none;
    color: inherit;
    transition: 0.15s ease;
}
.sst-card:hover {
    transform: translateY(-2px);
}
.sst-card-thumb {
    width: 100%;
    aspect-ratio: 1/1;
    object-fit: cover;
    border-radius: 14px;
    display: block;
    border: 1px solid rgba(255,255,255,0.08);
    background: #111827;
}
.sst-card:hover .sst-card-thumb {
    border-color: rgba(47,123,255,0.55);
}
.sst-card-name {
    font-size: 11px;
    line-height: 1.35;
    text-align: center;
    color: rgba(255,255,255,0.88);
    font-weight: 600;
    padding: 0 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.sst-card-no-img {
    width: 100%;
    aspect-ratio: 1/1;
    border-radius: 14px;
    background: #111827;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.25);
    font-size: 24px;
    border: 1px solid rgba(255,255,255,0.08);
}
`;

  document.head.appendChild(s);
};

ScreenshotTool.prototype._buildUI = function () {
  var self = this;
  var pos = this.buttonPosition || "bottom-left";

  var btn = document.createElement("button");
  btn.id = "sst-btn";
  btn.className = pos;
  btn.title = "Search Products";
    btn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
             stroke="rgba(255,255,255,0.9)" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
          <path d="M3 6h18"/>
          <path d="M16 10a4 4 0 0 1-8 0"/>
        </svg>
        <span>Search Products</span>
    `;
  btn.onclick = function (e) {
    e.stopPropagation();
    self._startCapture();
  };
  document.body.appendChild(btn);

  var overlay = document.createElement("div");
  overlay.id = "sst-overlay";
  overlay.innerHTML = `
        <div id="sst-mask-top"></div>
        <div id="sst-mask-bottom"></div>
        <div id="sst-mask-left"></div>
        <div id="sst-mask-right"></div>
        <div id="sst-sel">
            <div id="sst-sizelabel">0 × 0</div>
        </div>
    `;
  document.body.appendChild(overlay);

  var instruct = document.createElement("div");
  instruct.id = "sst-instruct";
  instruct.textContent = "Drag to select screenshot area · Press Esc to cancel";
  document.body.appendChild(instruct);

  var flash = document.createElement("div");
  flash.id = "sst-flash";
  document.body.appendChild(flash);

  var toast = document.createElement("div");
  toast.id = "sst-toast";
  toast.textContent = "Screenshot saved";
  document.body.appendChild(toast);

  var panel = document.createElement("div");
  panel.id = "sstPanel";
  panel.innerHTML = `
        <button id="sstPanelClose" type="button" aria-label="Close panel" title="Close panel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 6 15 12 9 18"></polyline>
            </svg>
        </button>

        <div id="sstPanelHeader">
            <div id="sstPanelTitle">Visual Matches</div>
            <div id="sstPanelSubtitle">Similar results from screenshot</div>
        </div>

        <div id="sstPreviewWrap">
            <img id="sstPreview" />
        </div>

        <div id="sstState">
            <div>Take a screenshot to search visual matches.</div>
        </div>

        <div id="sstScroll" style="display:none"></div>
    `;
  document.body.appendChild(panel);

  document.getElementById("sstPanelClose").onclick = function () {
    panel.classList.remove("open");
  };

  overlay.addEventListener("mousedown", function (e) {
    self._onDown(e);
  });

  overlay.addEventListener("mousemove", function (e) {
    self._onMove(e);
  });

  overlay.addEventListener("mouseup", function (e) {
    self._onUp(e);
  });

  this._onKey = function (e) {
    if (e.key === "Escape") self._cancelCapture();
  };

  document.addEventListener("keydown", this._onKey);
};

ScreenshotTool.prototype._lockCamera = function () {
  var camScript =
    this.cameraEntity &&
    this.cameraEntity.script &&
    this.cameraEntity.script.cameraManager;
  if (camScript) {
    this._prevCameraEnabled = camScript.enabled;
    this._prevBlockInput = camScript.blockInputFrame;

    camScript.blockInputFrame = true;
    camScript.isDragging = false;
    camScript.enabled = false;
  }
};

ScreenshotTool.prototype._unlockCamera = function () {
  var camScript =
    this.cameraEntity &&
    this.cameraEntity.script &&
    this.cameraEntity.script.cameraManager;
  if (camScript) {
    if (this._prevCameraEnabled !== undefined) {
      camScript.enabled = this._prevCameraEnabled;
    }
    if (this._prevBlockInput !== undefined) {
      camScript.blockInputFrame = this._prevBlockInput;
    }
  }
};

ScreenshotTool.prototype._startCapture = function () {
  // Tell other tools to disable themselves before we activate.
  window.dispatchEvent(
    new CustomEvent("vroomk:activate-tool", {
      detail: { tool: "screenshot" },
    }),
  );

  // Robust fallback: directly close the splat picker drawer so it
  // never lingers behind this one, even if its listener didn't fire.
  var sqPanel = document.getElementById("sqPanel");
  if (sqPanel) {
    sqPanel.classList.remove("open");
  }
  var sqReopen = document.getElementById("sqReopenBtn");
  if (sqReopen) {
    sqReopen.style.display = "none";
  }

  document.getElementById("sst-overlay").classList.add("active");
  document.getElementById("sst-instruct").style.display = "block";
  document.getElementById("sst-sel").style.display = "none";

  this._resetMasks();
  this._selecting = false;

  this._lockCamera();
};

ScreenshotTool.prototype._cancelCapture = function () {
  document.getElementById("sst-overlay").classList.remove("active");
  document.getElementById("sst-instruct").style.display = "none";
  document.getElementById("sst-sel").style.display = "none";

  this._resetMasks();
  this._selecting = false;

  this._unlockCamera();
};

ScreenshotTool.prototype._onDown = function (e) {
  this._selecting = true;
  this._startX = e.clientX;
  this._startY = e.clientY;

  var sel = document.getElementById("sst-sel");
  sel.style.left = e.clientX + "px";
  sel.style.top = e.clientY + "px";
  sel.style.width = "0px";
  sel.style.height = "0px";
  sel.style.display = "block";
};

ScreenshotTool.prototype._onMove = function (e) {
  if (!this._selecting) return;

  var x1 = Math.min(this._startX, e.clientX);
  var y1 = Math.min(this._startY, e.clientY);
  var x2 = Math.max(this._startX, e.clientX);
  var y2 = Math.max(this._startY, e.clientY);

  var w = x2 - x1;
  var h = y2 - y1;

  var sel = document.getElementById("sst-sel");
  sel.style.left = x1 + "px";
  sel.style.top = y1 + "px";
  sel.style.width = w + "px";
  sel.style.height = h + "px";

  document.getElementById("sst-sizelabel").textContent =
    Math.round(w) + " × " + Math.round(h);

  var W = window.innerWidth;
  var H = window.innerHeight;

  document.getElementById("sst-mask-top").style.cssText =
    "position:absolute;left:0;top:0;width:" +
    W +
    "px;height:" +
    y1 +
    "px;background:rgba(0,0,0,0.52)";

  document.getElementById("sst-mask-bottom").style.cssText =
    "position:absolute;left:0;top:" +
    y2 +
    "px;width:" +
    W +
    "px;height:" +
    (H - y2) +
    "px;background:rgba(0,0,0,0.52)";

  document.getElementById("sst-mask-left").style.cssText =
    "position:absolute;left:0;top:" +
    y1 +
    "px;width:" +
    x1 +
    "px;height:" +
    h +
    "px;background:rgba(0,0,0,0.52)";

  document.getElementById("sst-mask-right").style.cssText =
    "position:absolute;left:" +
    x2 +
    "px;top:" +
    y1 +
    "px;width:" +
    (W - x2) +
    "px;height:" +
    h +
    "px;background:rgba(0,0,0,0.52)";
};

ScreenshotTool.prototype._onUp = function (e) {
  if (!this._selecting) return;

  this._selecting = false;

  var x1 = Math.min(this._startX, e.clientX);
  var y1 = Math.min(this._startY, e.clientY);
  var w = Math.abs(e.clientX - this._startX);
  var h = Math.abs(e.clientY - this._startY);

  this._cancelCapture();

  if (w < 8 || h < 8) return;

  this._captureSceneNextFrame(x1, y1, w, h);
};

ScreenshotTool.prototype._captureSceneNextFrame = function (x, y, w, h) {
  var self = this;

  var flash = document.getElementById("sst-flash");
  flash.classList.add("pop");

  setTimeout(function () {
    flash.classList.remove("pop");
  }, 80);

  setTimeout(function () {
    self._captureFromRenderTarget(x, y, w, h);
  }, 100);
};

ScreenshotTool.prototype._captureFromRenderTarget = function (
  clientX,
  clientY,
  clientW,
  clientH,
) {
  var app = this.app;
  var gd = app.graphicsDevice;
  var canvas = gd.canvas;
  var gl = gd.gl;

  if (!gl) {
    this._showToast("❌ WebGL context not found");
    return;
  }

  var rect = canvas.getBoundingClientRect();
  var fullW = canvas.width;
  var fullH = canvas.height;

  var colorBuffer = new pc.Texture(gd, {
    width: fullW,
    height: fullH,
    format: pc.PIXELFORMAT_R8_G8_B8_A8,
    mipmaps: false,
  });

  colorBuffer.minFilter = pc.FILTER_LINEAR;
  colorBuffer.magFilter = pc.FILTER_LINEAR;
  colorBuffer.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
  colorBuffer.addressV = pc.ADDRESS_CLAMP_TO_EDGE;

  var renderTarget = new pc.RenderTarget({
    colorBuffer: colorBuffer,
    depth: true,
    autoResolve: true,
  });

  var cameras = app.root.findComponents("camera");
  var oldTargets = [];

  for (var i = 0; i < cameras.length; i++) {
    oldTargets[i] = cameras[i].renderTarget;
    cameras[i].renderTarget = renderTarget;
  }

  app.render();

  gd.setRenderTarget(renderTarget);
  gd.updateBegin();

  var pixels = new Uint8Array(fullW * fullH * 4);

  try {
    gl.readPixels(0, 0, fullW, fullH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } catch (err) {
    console.error("[ScreenshotTool] readPixels failed:", err);
    this._showToast("❌ Screenshot failed");
    gd.updateEnd();
    gd.setRenderTarget(null);
    return;
  }

  gd.updateEnd();
  gd.setRenderTarget(null);

  for (var j = 0; j < cameras.length; j++) {
    cameras[j].renderTarget = oldTargets[j];
  }

  renderTarget.destroy();
  colorBuffer.destroy();

  var scaleX = fullW / rect.width;
  var scaleY = fullH / rect.height;

  var sx = Math.round((clientX - rect.left) * scaleX);
  var syTop = Math.round((clientY - rect.top) * scaleY);
  var sw = Math.round(clientW * scaleX);
  var sh = Math.round(clientH * scaleY);

  sx = Math.max(0, Math.min(sx, fullW - 1));
  syTop = Math.max(0, Math.min(syTop, fullH - 1));
  sw = Math.max(1, Math.min(sw, fullW - sx));
  sh = Math.max(1, Math.min(sh, fullH - syTop));

  var out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;

  var ctx = out.getContext("2d");
  var imageData = ctx.createImageData(sw, sh);

  for (var yy = 0; yy < sh; yy++) {
    for (var xx = 0; xx < sw; xx++) {
      var srcX = sx + xx;
      var srcY = fullH - (syTop + yy) - 1;

      var srcIndex = (srcY * fullW + srcX) * 4;
      var dstIndex = (yy * sw + xx) * 4;

      imageData.data[dstIndex] = pixels[srcIndex];
      imageData.data[dstIndex + 1] = pixels[srcIndex + 1];
      imageData.data[dstIndex + 2] = pixels[srcIndex + 2];
      imageData.data[dstIndex + 3] = pixels[srcIndex + 3];
    }
  }

  ctx.putImageData(imageData, 0, 0);

  var self = this;

  out.toBlob(function (blob) {
    if (!blob) {
      self._showToast("❌ Could not create image");
      return;
    }

    var dataUrl = out.toDataURL("image/png");

    self._showToast("📷 Screenshot captured " + sw + "×" + sh);
    self._showPanelLoading(dataUrl);
    self._uploadToCloudinary(blob);
  }, "image/png");
};

ScreenshotTool.prototype._showPanelLoading = function (previewDataUrl) {
  var panel = document.getElementById("sstPanel");
  var previewWrap = document.getElementById("sstPreviewWrap");
  var preview = document.getElementById("sstPreview");
  var state = document.getElementById("sstState");
  var scroll = document.getElementById("sstScroll");

  preview.src = previewDataUrl;
  previewWrap.style.display = "block";

  scroll.style.display = "none";
  scroll.innerHTML = "";

  state.style.display = "block";
  state.innerHTML =
    '<div class="sst-spinner"></div><div>Uploading screenshot and searching matches...</div>';

  panel.classList.add("open");
};

ScreenshotTool.prototype._uploadToCloudinary = function (blob) {
  var self = this;

  var cloudName = this.cloudinaryCloudName;
  var preset = this.cloudinaryUploadPreset;

  if (!cloudName || cloudName === "YOUR_CLOUD_NAME") {
    self._showPanelError("Set Cloudinary Cloud Name in script attributes.");
    return;
  }

  if (!preset || preset === "YOUR_UPLOAD_PRESET") {
    self._showPanelError("Set Cloudinary Upload Preset in script attributes.");
    return;
  }

  var uploadUrl =
    "https://api.cloudinary.com/v1_1/" + cloudName + "/image/upload";

  var form = new FormData();
  form.append("file", blob, "screenshot.png");
  form.append("upload_preset", preset);

  fetch(uploadUrl, {
    method: "POST",
    body: form,
  })
    .then(function (res) {
      if (!res.ok) throw new Error("Cloudinary HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data.secure_url)
        throw new Error("No Cloudinary secure_url returned");
      self._queryGoogleLens(data.secure_url);
    })
    .catch(function (err) {
      console.error("[ScreenshotTool] Cloudinary upload failed:", err);
      self._showPanelError("Upload failed: " + err.message);
    });
};

ScreenshotTool.prototype._queryGoogleLens = function (imageUrl) {
  var self = this;

  if (!this.searchApiKey || this.searchApiKey === "YOUR_SEARCHAPI_KEY") {
    self._showPanelError("Set SearchAPI key in script attributes.");
    return;
  }

  var apiUrl =
    "https://www.searchapi.io/api/v1/search" +
    "?engine=google_lens" +
    "&url=" +
    encodeURIComponent(imageUrl) +
    "&search_type=products";

  fetch(apiUrl, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + this.searchApiKey,
      "Content-Type": "application/json",
    },
  })
    .then(function (res) {
      if (!res.ok) throw new Error("SearchAPI HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      self._showPanelResults(data);
    })
    .catch(function (err) {
      console.error("[ScreenshotTool] SearchAPI failed:", err);
      self._showPanelError("Search failed: " + err.message);
    });
};

ScreenshotTool.prototype._showPanelResults = function (data) {
  var matches = data.visual_matches || data.product_results || [];
  var state = document.getElementById("sstState");
  var scroll = document.getElementById("sstScroll");

  if (!matches || matches.length === 0) {
    state.style.display = "block";
    state.innerHTML =
      "<div>🔍<br>No visual matches found.<br><small>Try selecting a clearer object.</small></div>";
    scroll.style.display = "none";
    return;
  }

  state.style.display = "none";
  scroll.style.display = "grid";
  scroll.innerHTML = "";

  matches.forEach(function (item, index) {
    var title = item.title || item.name || "Untitled result";
    var link = item.link || item.source_link || item.url || "#";
    var thumbUrl =
      item.thumbnail ||
      item.thumbnail_url ||
      item.image ||
      (item.image && item.image.link) ||
      "";

    var card = document.createElement("a");
    card.className = "sst-card";
    card.href = link;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.title = title;

    if (thumbUrl && typeof thumbUrl === "string") {
      var img = document.createElement("img");
      img.className = "sst-card-thumb";
      img.src = thumbUrl;
      img.alt = title;
      img.loading = "lazy";

      img.onerror = function () {
        var noImg = document.createElement("div");
        noImg.className = "sst-card-no-img";
        noImg.textContent = "🖼";
        card.replaceChild(noImg, img);
      };

      card.appendChild(img);
    } else {
      var noImg = document.createElement("div");
      noImg.className = "sst-card-no-img";
      noImg.textContent = "🖼";
      card.appendChild(noImg);
    }

    var name = document.createElement("div");
    name.className = "sst-card-name";
    name.textContent = title;

    card.appendChild(name);
    scroll.appendChild(card);
  });
};

ScreenshotTool.prototype._showPanelError = function (msg) {
  var panel = document.getElementById("sstPanel");
  var state = document.getElementById("sstState");
  var scroll = document.getElementById("sstScroll");

  panel.classList.add("open");
  scroll.style.display = "none";
  state.style.display = "block";
  state.innerHTML = '<div style="color:#f87171">⚠️<br>' + msg + "</div>";
};

ScreenshotTool.prototype._downloadBlob = function (blob, w, h) {
  var url = URL.createObjectURL(blob);

  var a = document.createElement("a");
  a.href = url;
  a.download = "playcanvas_scene_screenshot_" + Date.now() + ".png";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);

  this._showToast("✅ Screenshot saved! " + w + "×" + h);
};

ScreenshotTool.prototype._showToast = function (msg) {
  var toast = document.getElementById("sst-toast");
  if (!toast) return;

  toast.textContent = msg;
  toast.classList.add("show");

  clearTimeout(this._toastTimer);

  this._toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 3000);
};

ScreenshotTool.prototype._resetMasks = function () {
  [
    "sst-mask-top",
    "sst-mask-bottom",
    "sst-mask-left",
    "sst-mask-right",
  ].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.style.cssText = "position:absolute;background:rgba(0,0,0,0.52)";
    }
  });
};

ScreenshotTool.prototype.destroy = function () {
  document.removeEventListener("keydown", this._onKey);

  if (this._toolActivateHandler) {
    window.removeEventListener(
      "vroomk:activate-tool",
      this._toolActivateHandler,
    );
    this._toolActivateHandler = null;
  }

  [
    "sst-btn",
    "sst-overlay",
    "sst-instruct",
    "sst-flash",
    "sst-toast",
    "sst-style",
    "sstPanel",
  ].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });
};

