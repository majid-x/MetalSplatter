// ============================================================
// SimpleScreenshotTool.js — PlayCanvas Script
// Screenshot scene → download to device
// ============================================================

var SimpleScreenshotTool = pc.createScript("simpleScreenshotTool");

SimpleScreenshotTool.attributes.add("buttonPosition", {
  type: "string",
  default: "bottom-left",
  title: "Button Position",
  description: "Where to place the screenshot button",
});

SimpleScreenshotTool.attributes.add("buttonOffsetFromBottom", {
  type: "number",
  default: 144,
  title: "Offset From Bottom (px)",
  description:
    "How far from bottom when in bottom position (for stacking above other UI)",
});

SimpleScreenshotTool.attributes.add("cameraEntity", {
  type: "entity",
  title: "Player Camera Entity",
  description:
    "The primary camera entity (optional - locks rotation during capture)",
});

SimpleScreenshotTool.prototype.initialize = function () {
  this._selecting = false;
  this._startX = 0;
  this._startY = 0;

  this._injectStyles();
  this._buildUI();

  // When any OTHER tool becomes active, cancel capture so only one tool runs.
  var self = this;
  this._toolActivateHandler = function (event) {
    if (event && event.detail && event.detail.tool !== "take-screenshot") {
      self._cancelCapture();
    }
  };
  window.addEventListener("vroomk:activate-tool", this._toolActivateHandler);

  console.log("[SimpleScreenshotTool] Ready");
};

SimpleScreenshotTool.prototype._injectStyles = function () {
  if (document.getElementById("sss-style")) return;

  var s = document.createElement("style");
  s.id = "sss-style";

  s.textContent = `
#sss-btn {
    position: fixed;
    z-index: 2147483640;
    height: 46px;
    border-radius: 12px;
    background: rgba(13,15,20,0.9);
    border: 1px solid rgba(255,255,255,0.15);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 14px;
    transition: 0.15s ease;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
    white-space: nowrap;
}
#sss-btn:hover {
    background: rgba(13,15,20,0.95);
    border-color: rgba(47,123,255,0.5);
}
#sss-btn.bottom-left { bottom: 144px; left: 24px; }
#sss-btn.bottom-right { bottom: 24px; right: 24px; }
#sss-btn.top-left { top: 24px; left: 24px; }
#sss-btn.top-right { top: 24px; right: 24px; }

#sss-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483641;
    cursor: crosshair;
    display: none;
    user-select: none;
}
#sss-overlay.active { display: block; }

#sss-mask-top,
#sss-mask-bottom,
#sss-mask-left,
#sss-mask-right {
    position: absolute;
    background: rgba(0,0,0,0.52);
}

#sss-sel {
    position: absolute;
    border: 2px solid #2f7bff;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5);
    display: none;
    pointer-events: none;
}

#sss-sizelabel {
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

#sss-instruct {
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

#sss-flash {
    position: fixed;
    inset: 0;
    background: white;
    z-index: 2147483643;
    opacity: 0;
    pointer-events: none;
}
#sss-flash.pop { opacity: 0.35; }

#sss-toast {
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
#sss-toast.show {
    opacity: 1;
    transform: translateY(0);
}
`;

  document.head.appendChild(s);
};

SimpleScreenshotTool.prototype._buildUI = function () {
  var self = this;
  var pos = this.buttonPosition || "bottom-left";
  var offset = this.buttonOffsetFromBottom || 144;

  // Screenshot button
  var btn = document.createElement("button");
  btn.id = "sss-btn";
  btn.className = pos;
  btn.title = "Take a screenshot (click or drag to select area)";
  btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="rgba(255,255,255,0.9)" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8
                   a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        <span>Take Screenshot</span>
    `;

  // Apply dynamic offset for bottom positions
  if (pos.indexOf("bottom") !== -1) {
    btn.style.bottom = offset + "px";
  }

  btn.onclick = function (e) {
    e.stopPropagation();
    self._startCapture();
  };
  document.body.appendChild(btn);

  // Selection overlay
  var overlay = document.createElement("div");
  overlay.id = "sss-overlay";
  overlay.innerHTML = `
        <div id="sss-mask-top"></div>
        <div id="sss-mask-bottom"></div>
        <div id="sss-mask-left"></div>
        <div id="sss-mask-right"></div>
        <div id="sss-sel">
            <div id="sss-sizelabel">0 × 0</div>
        </div>
    `;
  document.body.appendChild(overlay);

  // Instructions
  var instruct = document.createElement("div");
  instruct.id = "sss-instruct";
  instruct.textContent =
    "Drag to select area · Click for full screenshot · Press Esc to cancel";
  document.body.appendChild(instruct);

  // Flash effect
  var flash = document.createElement("div");
  flash.id = "sss-flash";
  document.body.appendChild(flash);

  // Toast notification
  var toast = document.createElement("div");
  toast.id = "sss-toast";
  document.body.appendChild(toast);

  // Event listeners
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

SimpleScreenshotTool.prototype._lockCamera = function () {
  if (!this.cameraEntity) return;

  var camScript =
    this.cameraEntity.script && this.cameraEntity.script.cameraManager;
  if (camScript) {
    this._prevCameraEnabled = camScript.enabled;
    this._prevBlockInput = camScript.blockInputFrame;
    camScript.blockInputFrame = true;
    camScript.isDragging = false;
    camScript.enabled = false;
  }
};

SimpleScreenshotTool.prototype._unlockCamera = function () {
  if (!this.cameraEntity) return;

  var camScript =
    this.cameraEntity.script && this.cameraEntity.script.cameraManager;
  if (camScript) {
    if (this._prevCameraEnabled !== undefined) {
      camScript.enabled = this._prevCameraEnabled;
    }
    if (this._prevBlockInput !== undefined) {
      camScript.blockInputFrame = this._prevBlockInput;
    }
  }
};

SimpleScreenshotTool.prototype._startCapture = function () {
  // Tell other tools (measurement, search images, search products) to deactivate.
  window.dispatchEvent(
    new CustomEvent("vroomk:activate-tool", {
      detail: { tool: "take-screenshot" },
    }),
  );

  // Close splat image-search drawer if open.
  var sqPanel = document.getElementById("sqPanel");
  if (sqPanel) {
    sqPanel.classList.remove("open");
  }
  var sqReopen = document.getElementById("sqReopenBtn");
  if (sqReopen) {
    sqReopen.style.display = "none";
  }

  document.getElementById("sss-overlay").classList.add("active");
  document.getElementById("sss-instruct").style.display = "block";
  document.getElementById("sss-sel").style.display = "none";

  this._resetMasks();
  this._selecting = false;

  this._lockCamera();
};

SimpleScreenshotTool.prototype._cancelCapture = function () {
  document.getElementById("sss-overlay").classList.remove("active");
  document.getElementById("sss-instruct").style.display = "none";
  document.getElementById("sss-sel").style.display = "none";

  this._resetMasks();
  this._selecting = false;

  this._unlockCamera();
};

SimpleScreenshotTool.prototype._onDown = function (e) {
  this._selecting = true;
  this._startX = e.clientX;
  this._startY = e.clientY;

  var sel = document.getElementById("sss-sel");
  sel.style.left = e.clientX + "px";
  sel.style.top = e.clientY + "px";
  sel.style.width = "0px";
  sel.style.height = "0px";
  sel.style.display = "block";
};

SimpleScreenshotTool.prototype._onMove = function (e) {
  if (!this._selecting) return;

  var x1 = Math.min(this._startX, e.clientX);
  var y1 = Math.min(this._startY, e.clientY);
  var x2 = Math.max(this._startX, e.clientX);
  var y2 = Math.max(this._startY, e.clientY);

  var w = x2 - x1;
  var h = y2 - y1;

  var sel = document.getElementById("sss-sel");
  sel.style.left = x1 + "px";
  sel.style.top = y1 + "px";
  sel.style.width = w + "px";
  sel.style.height = h + "px";

  document.getElementById("sss-sizelabel").textContent =
    Math.round(w) + " × " + Math.round(h);

  var W = window.innerWidth;
  var H = window.innerHeight;

  document.getElementById("sss-mask-top").style.cssText =
    "position:absolute;left:0;top:0;width:" +
    W +
    "px;height:" +
    y1 +
    "px;background:rgba(0,0,0,0.52)";

  document.getElementById("sss-mask-bottom").style.cssText =
    "position:absolute;left:0;top:" +
    y2 +
    "px;width:" +
    W +
    "px;height:" +
    (H - y2) +
    "px;background:rgba(0,0,0,0.52)";

  document.getElementById("sss-mask-left").style.cssText =
    "position:absolute;left:0;top:" +
    y1 +
    "px;width:" +
    x1 +
    "px;height:" +
    h +
    "px;background:rgba(0,0,0,0.52)";

  document.getElementById("sss-mask-right").style.cssText =
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

SimpleScreenshotTool.prototype._onUp = function (e) {
  if (!this._selecting) return;

  this._selecting = false;

  var x1 = Math.min(this._startX, e.clientX);
  var y1 = Math.min(this._startY, e.clientY);
  var w = Math.abs(e.clientX - this._startX);
  var h = Math.abs(e.clientY - this._startY);

  this._cancelCapture();

  // If selection too small, do full screenshot instead
  if (w < 8 || h < 8) {
    this._captureFullScreen();
    return;
  }

  this._captureSceneNextFrame(x1, y1, w, h);
};

SimpleScreenshotTool.prototype._captureFullScreen = function () {
  var self = this;
  var flash = document.getElementById("sss-flash");
  flash.classList.add("pop");

  setTimeout(function () {
    flash.classList.remove("pop");
  }, 80);

  setTimeout(function () {
    var app = self.app;
    var gd = app.graphicsDevice;
    var canvas = gd.canvas;
    var fullW = canvas.width;
    var fullH = canvas.height;

    self._captureFromRenderTarget(0, 0, fullW, fullH);
  }, 100);
};

SimpleScreenshotTool.prototype._captureSceneNextFrame = function (x, y, w, h) {
  var self = this;

  var flash = document.getElementById("sss-flash");
  flash.classList.add("pop");

  setTimeout(function () {
    flash.classList.remove("pop");
  }, 80);

  setTimeout(function () {
    self._captureFromRenderTarget(x, y, w, h);
  }, 100);
};

SimpleScreenshotTool.prototype._captureFromRenderTarget = function (
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

  // Create a texture to render the scene into
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

  // Redirect cameras to render target
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
    console.error("[SimpleScreenshotTool] readPixels failed:", err);
    this._showToast("❌ Screenshot failed");
    gd.updateEnd();
    gd.setRenderTarget(null);
    return;
  }

  gd.updateEnd();
  gd.setRenderTarget(null);

  // Restore cameras
  for (var j = 0; j < cameras.length; j++) {
    cameras[j].renderTarget = oldTargets[j];
  }

  renderTarget.destroy();
  colorBuffer.destroy();

  // Calculate the cropped region
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

  // Create canvas for cropped image
  var out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;

  var ctx = out.getContext("2d");
  var imageData = ctx.createImageData(sw, sh);

  // Copy pixels (with Y-axis flip because WebGL is bottom-up)
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

    self._downloadBlob(blob, sw, sh);
  }, "image/png");
};

SimpleScreenshotTool.prototype._downloadBlob = function (blob, w, h) {
  var url = URL.createObjectURL(blob);

  var a = document.createElement("a");
  a.href = url;
  a.download = "screenshot_" + Date.now() + ".png";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);

  this._showToast("✅ Screenshot saved! " + w + "×" + h);
};

SimpleScreenshotTool.prototype._showToast = function (msg) {
  var toast = document.getElementById("sss-toast");
  if (!toast) return;

  toast.textContent = msg;
  toast.classList.add("show");

  clearTimeout(this._toastTimer);

  this._toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 3000);
};

SimpleScreenshotTool.prototype._resetMasks = function () {
  [
    "sss-mask-top",
    "sss-mask-bottom",
    "sss-mask-left",
    "sss-mask-right",
  ].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.style.cssText = "position:absolute;background:rgba(0,0,0,0.52)";
    }
  });
};

SimpleScreenshotTool.prototype.destroy = function () {
  document.removeEventListener("keydown", this._onKey);

  if (this._toolActivateHandler) {
    window.removeEventListener("vroomk:activate-tool", this._toolActivateHandler);
    this._toolActivateHandler = null;
  }

  [
    "sss-btn",
    "sss-overlay",
    "sss-instruct",
    "sss-flash",
    "sss-toast",
    "sss-style",
  ].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });
};

