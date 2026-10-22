// ============================================================
// SplatClickQuery.js
// PlayCanvas Script
// Fullscreen image viewer + reliable PDF export
// FIXED: Camera rotation is locked for the entire pick-a-point mode (same way as
//        ScreenshotTool, via the "cameraManager" script on Camera-Main).
// FIXED: The blue marker dot stays PINNED to the clicked screen
//        position. It no longer drifts/moves with the camera.
// Attach this script to the Root entity.
// ============================================================

var SplatClickQuery = pc.createScript("splatClickQuery");

// ============================================================
// SCRIPT ATTRIBUTES
// ============================================================

SplatClickQuery.attributes.add("apiBase", {
  type: "string",
  default: "",
  title: "API Base URL",
  description: "Leave EMPTY to fetch from Supabase only",
});

SplatClickQuery.attributes.add("supabaseURL", {
  type: "string",
  default: "https://mhcrfzznildwzopnveow.supabase.co",
  title: "Supabase URL",
  description: "Your Supabase project URL (optional)",
});

SplatClickQuery.attributes.add("supabaseKey", {
  type: "string",
  default: "sb_publishable_6iBgGmUPGWk_OCoJ4PeS-A_2SIzzbxR",
  title: "Supabase Publishable Key",
  description:
    "Publishable API key from Supabase settings (RLS must be disabled on urls table)",
});

SplatClickQuery.attributes.add("projectName", {
  type: "string",
  default: "hakob1",
  title: "Project Name",
  description: "Project name to query from Supabase (optional)",
});

SplatClickQuery.attributes.add("maxResults", {
  type: "number",
  default: 6,
  title: "Max Results",
  description: "Images per request (initial load and each Fetch More click)",
});

SplatClickQuery.attributes.add("centerThreshold", {
  type: "number",
  default: 0.3,
  title: "Center Threshold",
  description: "0.25 = tight center, 1.0 = loose center",
});

SplatClickQuery.attributes.add("sampleDepth", {
  type: "number",
  default: 3,
  title: "Sample Depth",
  description: "Distance along the camera ray",
});

SplatClickQuery.attributes.add("splatEntityName", {
  type: "string",
  default: "Gevork kitchen.sog",
  title: "Splat Entity Name",
  description: "Exact name of the GSplat entity",
});

// The splat shown in PlayCanvas may be normalized (rescaled/recentered/
// reoriented) relative to the original COLMAP model the photo_api was built on.
// After converting the clicked point into splat-local space, we apply this
// similarity transform to recover the COLMAP coordinate the API expects:
//     colmap = (coordRotation * coordScale * localPoint) + coordOffset
// Leave scale=1, offset=0, rotation=0 for the original (identity) behaviour.
SplatClickQuery.attributes.add("coordinateScale", {
  type: "number",
  default: 0.5870968,
  title: "COLMAP Scale",
  description:
    "Uniform scale from splat-local units to COLMAP units. Try the measurer's calibrationFactor (e.g. 0.5870968) if the splat was normalized.",
});

SplatClickQuery.attributes.add("coordinateRotation", {
  type: "vec3",
  default: [0, 0, 0],
  title: "COLMAP Rotation (deg)",
  description:
    "Extra Euler rotation (degrees) applied to the local point before offset. Use only if the normalization reoriented the splat.",
});

SplatClickQuery.attributes.add("coordinateOffset", {
  type: "vec3",
  default: [0, 0, 0],
  title: "COLMAP Offset",
  description:
    "Translation added after scale+rotation, in COLMAP units. Use if the splat was recentered relative to COLMAP.",
});

// When enabled, the query sends the viewer's current camera position and view
// direction (in COLMAP space) so results can be biased toward photos taken from
// a similar angle to what you're looking at, instead of every camera that can
// see the point. The API must honour "camera_position" / "view_direction" /
// "max_view_angle" for server-side filtering; the client also re-ranks returned
// photos by view angle when the response exposes per-photo camera data.
// When ON, the client sends RAW PlayCanvas world coordinates and the server
// applies its fitted calibration transform (from /calibrate). Turn this on only
// AFTER running sqCal.compute() with 3+ pairs. When OFF, the client sends its own
// COLMAP estimate (COLMAP Scale/Rotation/Offset above).
SplatClickQuery.attributes.add("useServerCalibration", {
  type: "boolean",
  default: true,
  title: "Use Server Calibration",
  description:
    "Send raw world coords and let the server's calibrated transform map them to COLMAP. Enable after sqCal.compute().",
});

SplatClickQuery.attributes.add("viewFilterEnabled", {
  type: "boolean",
  default: true,
  title: "View Angle Filter",
  description:
    "Bias returned photos toward your current viewing angle (needs camera pose sent to / returned by the API).",
});

SplatClickQuery.attributes.add("maxViewAngle", {
  type: "number",
  default: 55,
  title: "Max View Angle (deg)",
  description:
    "Only keep photos whose viewing direction is within this many degrees of your current view. Larger = looser.",
});

SplatClickQuery.attributes.add("orbitMouseButton", {
  type: "number",
  default: 1,
  title: "Orbit Drag Mouse Button",
  description:
    "Mouse button for camera orbit while search mode is active. 0=Left, 1=Middle, 2=Right. Default: 1 (Middle), same as the measurer.",
});

SplatClickQuery.attributes.add("orbitDragSensitivity", {
  type: "number",
  default: 0.3,
  title: "Orbit Drag Sensitivity",
  description: "Mouse sensitivity for orbit dragging in search mode.",
});

// ============================================================
// INITIALIZE
// ============================================================

SplatClickQuery.prototype.initialize = function () {
  this._imageData = [];
  this._selectedIndices = [];

  this._lastClickX = 0;
  this._lastClickY = 0;

  this._active = false;
  this._pdfLibraryPromise = null;
  this._escapeHandler = null;
  this._markerToggleHandler = null;
  this._marker = null;
  this._fullscreenIndex = -1;

  // When true, the API draws a crosshair marker on returned images.
  // Toggle with Ctrl+P. Defaults to off.
  this._addMarker = false;

  // Calibration console UI (Ctrl+Q toggles this panel).
  this._calPanelOpen = false;
  this._calPanelToggleHandler = null;
  // In-memory only: survives repeated Ctrl+Q toggles, resets on page refresh.
  this._calAuthOk = false;

  // Fetch More: grows max_results by maxResults each click (6 → 12 → 18 …)
  this._lastQueryCoords = null;
  this._currentMaxResults = this.maxResults || 6;
  this._hasMore = false;

  // Orbit-drag state (middle-mouse by default, like SplatMeasurer).
  this._isOrbitDragging = false;
  this._lastDragX = 0;
  this._lastDragY = 0;

  // Prevent duplicate UI when the script is reparsed.
  this._removeExistingUI();
  this._buildUI();

  // When any OTHER tool becomes active, disable this one so only a
  // single tool is ever active at a time.
  var self = this;

  this._toolActivateHandler = function (event) {
    if (event && event.detail && event.detail.tool !== "splat") {
      if (self._active) {
        self._setActive(false);
      }

      self._closePanel();
    }
  };

  window.addEventListener("vroomk:activate-tool", this._toolActivateHandler);

  this.app.mouse.on(pc.EVENT_MOUSEDOWN, this._onMouseDown, this);
  this.app.mouse.on(pc.EVENT_MOUSEMOVE, this._onMouseMove, this);
  this.app.mouse.on(pc.EVENT_MOUSEUP, this._onMouseUp, this);

  if (this.app.touch) {
    this.app.touch.on(pc.EVENT_TOUCHSTART, this._onTouchStart, this);
  }

  // Real surface picking against the splat (GPU depth readback), the same
  // approach SplatMeasurer uses. This replaces the old fixed-depth guess so the
  // clicked 3D point lands on the actual surface the user pointed at.
  var device = this.app.graphicsDevice;
  this._picker = new pc.Picker(this.app, device.width, device.height, true);
  this._onPickerResize = function (width, height) {
    if (self._picker) {
      self._picker.resize(width, height);
    }
  };
  device.on("resizecanvas", this._onPickerResize, this);

  // Fetch API URL from Supabase if not hardcoded
  if (!this.apiBase || this.apiBase === "") {
    this._fetchAPIURLFromSupabase();
  }

  this._setupCalibrationConsole();
};

// ============================================================
// CALIBRATION CONSOLE HELPERS
// Build an exact world->COLMAP transform from real feature correspondences using
// the server's Procrustes fit. Workflow:
//   1. Click a distinct feature in PlayCanvas (a corner, the trash can, etc).
//   2. Read that feature's COLMAP xyz from the /viewer.
//   3. In the browser console:  sqCal.add(cx, cy, cz)
//   4. Repeat for 4-6 spread-out features, then:  sqCal.compute()
//   5. Set the "Use Server Calibration" attribute ON so queries send raw world.
// Other commands: sqCal.status(), sqCal.clear(), sqCal.help()
// ============================================================

SplatClickQuery.prototype._setupCalibrationConsole = function () {
  var self = this;

  function base() {
    return String(self.apiBase || "").replace(/\/$/, "");
  }

  function req(path, method, body) {
    return fetch(base() + path, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json();
    });
  }

  window.sqCal = {
    add: function (cx, cy, cz, label) {
      if (!self._lastWorld) {
        console.warn(
          "[sqCal] No point clicked yet. Click a feature in PlayCanvas first.",
        );
        return;
      }

      if (cx == null || cy == null || cz == null) {
        console.warn("[sqCal] Usage: sqCal.add(colmapX, colmapY, colmapZ)");
        return;
      }

      var w = self._lastWorld;

      return req("/calibrate/add", "POST", {
        label: label || "pair_" + Date.now(),
        splat_xyz: [w.x, w.y, w.z],
        colmap_xyz: [Number(cx), Number(cy), Number(cz)],
      }).then(function (d) {
        console.log(
          "[sqCal] Added pair #" +
            (d.pair_count || "?") +
            "  world[" +
            w.x.toFixed(4) +
            ", " +
            w.y.toFixed(4) +
            ", " +
            w.z.toFixed(4) +
            "]  ->  colmap[" +
            cx +
            ", " +
            cy +
            ", " +
            cz +
            "]",
        );

        if ((d.pair_count || 0) >= 3) {
          console.log("[sqCal] You have enough pairs. Run sqCal.compute().");
        }

        return d;
      });
    },

    compute: function () {
      return req("/calibrate/compute", "POST").then(function (d) {
        if (d.error) {
          console.warn("[sqCal] compute:", d.error);
        } else {
          console.log(
            "[sqCal] Fit complete. scale=" +
              (d.scale != null ? d.scale.toFixed(5) : "?") +
              "  mean_error=" +
              (d.mean_error != null ? d.mean_error.toFixed(4) : "?"),
          );
          console.log(
            "[sqCal] Per-pair residuals:",
            (d.residuals || []).map(function (r) {
              return r.error.toFixed(4);
            }),
          );
          console.log(
            "[sqCal] Now turn ON the 'Use Server Calibration' attribute so " +
              "queries send raw world coords.",
          );
        }
        return d;
      });
    },

    status: function () {
      return req("/calibrate/status", "GET").then(function (d) {
        console.log(
          "[sqCal] pairs=" +
            (d.pair_count || 0) +
            "  transform_active=" +
            (d.transform != null),
          d,
        );
        return d;
      });
    },

    clear: function () {
      return req("/calibrate/clear", "DELETE").then(function (d) {
        console.log("[sqCal] Cleared all calibration pairs and transform.");
        return d;
      });
    },

    help: function () {
      console.log(
        "[sqCal] 1) click a feature  2) sqCal.add(colmapX,colmapY,colmapZ) " +
          "from the viewer  3) repeat 4-6x  4) sqCal.compute()  5) enable " +
          "'Use Server Calibration'.  Also: sqCal.status(), sqCal.clear().",
      );
    },
  };
};

// ============================================================
// CAMERA ORBIT (while search mode is active)
// Same pattern as SplatMeasurer: left-click picks a point, middle-drag orbits.
// cameraManager yields input while this tool is active.
// ============================================================

SplatClickQuery.prototype._getCameraManagerScript = function () {
  var cameraMain = this.app.root.findByName("Camera-Main");

  if (cameraMain && cameraMain.script && cameraMain.script.cameraManager) {
    return cameraMain.script.cameraManager;
  }

  var camera = this.app.root.findByName("Camera");

  if (camera && camera.script && camera.script.cameraManager) {
    return camera.script.cameraManager;
  }

  var matches = this.app.root.find(function (node) {
    return node.script && node.script.cameraManager;
  });

  return matches.length > 0 ? matches[0].script.cameraManager : null;
};

SplatClickQuery.prototype._stopCameraDrag = function () {
  var camScript = this._getCameraManagerScript();
  if (camScript && typeof camScript.suppressOrbitInput === "function") {
    camScript.suppressOrbitInput();
  } else if (camScript) {
    camScript.isDragging = false;
    camScript.dragType = null;
  }
};

SplatClickQuery.prototype._setCameraToolLock = function (locked) {
  var camScript = this._getCameraManagerScript();
  if (camScript && typeof camScript.setToolInputLock === "function") {
    camScript.setToolInputLock(locked);
  } else if (locked) {
    this._stopCameraDrag();
  }
};

// Keep every splatClickQuery instance in sync (script may exist on
// multiple entities; only one builds the UI but all register mouse handlers).
SplatClickQuery.prototype._syncActiveAcrossInstances = function (active) {
  var entities = this.app.root.find(function (node) {
    return node.script && node.script.splatClickQuery;
  });

  for (var i = 0; i < entities.length; i++) {
    var sq = entities[i].script.splatClickQuery;
    if (sq) {
      sq._active = active;
      sq._isOrbitDragging = false;
    }
  }
};

// ============================================================
// UPDATE LOOP
// The marker dot is intentionally NOT repositioned here. It stays
// pinned to the exact screen location where the user clicked, so it
// never drifts or moves with the camera.
// ============================================================

SplatClickQuery.prototype.update = function (dt) {
  if (this._active) {
    this._setCameraToolLock(true);
  }
};

// ============================================================
// FETCH API URL FROM SUPABASE
// ============================================================

SplatClickQuery.prototype._fetchAPIURLFromSupabase = function () {
  var self = this;
  var supabaseURL = String(this.supabaseURL || "").replace(/\/$/, "");
  var supabaseKey = this.supabaseKey || "";
  var projectName = this.projectName || "hakob1";

  if (!supabaseURL || !supabaseKey) {
    console.error("[SplatClickQuery] Supabase credentials missing!");
    return;
  }

  var queryURL =
    supabaseURL +
    "/rest/v1/urls?project_name=eq." +
    encodeURIComponent(projectName) +
    "&select=url";

  fetch(queryURL, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + supabaseKey,
      apikey: supabaseKey,
      "Content-Type": "application/json",
    },
  })
    .then(function (response) {
      if (!response.ok) {
        throw new Error(
          "HTTP " +
            response.status +
            " - " +
            response.statusText +
            ". Verify your key and RLS settings.",
        );
      }
      return response.json();
    })
    .then(function (data) {
      if (Array.isArray(data) && data.length > 0) {
        var urlRecord = data[0];
        if (urlRecord && urlRecord.url) {
          self.apiBase = String(urlRecord.url).replace(/\/$/, "");
        } else {
          console.warn(
            "[SplatClickQuery] No URL field found in Supabase record:",
            urlRecord,
          );
        }
      } else {
        console.warn(
          '[SplatClickQuery] No records found for project "' +
            projectName +
            '". Check if the record exists in Supabase.',
        );
      }
    })
    .catch(function (error) {
      console.error("[SplatClickQuery] Supabase fetch failed:", error.message);
      console.error(
        "[SplatClickQuery] Troubleshooting - Check all of these:",
        "1. Supabase URL: " + supabaseURL,
        "2. Key is valid (starts with sb_)",
        '3. Table "urls" exists',
        '4. Record with project_name="' + projectName + '" exists',
        "5. RLS is DISABLED on urls table",
        "6. If RLS enabled, check policies allow access",
      );
    });
};

// ============================================================
// REMOVE DUPLICATE UI
// ============================================================

SplatClickQuery.prototype._removeExistingUI = function () {
  var ids = [
    "sqPanel",
    "sqTriggerBtn",
    "sqDot",
    "sqHint",
    "sqReopenBtn",
    "sqFullscreenModal",
    "sqStyle",
    "sqFont",
  ];

  ids.forEach(function (id) {
    var element = document.getElementById(id);

    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
  });
};

// ============================================================
// JSPDF LIBRARY
// ============================================================

SplatClickQuery.prototype._getJsPDFConstructor = function () {
  // UMD browser build.
  if (window.jspdf && typeof window.jspdf.jsPDF === "function") {
    return window.jspdf.jsPDF;
  }

  // Fallback in case jsPDF was manually exposed globally.
  if (typeof window.jsPDF === "function") {
    return window.jsPDF;
  }

  return null;
};

SplatClickQuery.prototype._loadPDFLibrary = function () {
  var existingConstructor = this._getJsPDFConstructor();

  if (existingConstructor) {
    return Promise.resolve(existingConstructor);
  }

  if (this._pdfLibraryPromise) {
    return this._pdfLibraryPromise;
  }

  var self = this;

  var sources = [
    "https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js",
    "https://unpkg.com/jspdf@4.2.1/dist/jspdf.umd.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js",
  ];

  this._pdfLibraryPromise = new Promise(function (resolve, reject) {
    var sourceIndex = 0;

    function removeLoader() {
      var oldLoader = document.getElementById("sqJsPdfLoader");

      if (oldLoader && oldLoader.parentNode) {
        oldLoader.parentNode.removeChild(oldLoader);
      }
    }

    function tryNextSource() {
      var constructor = self._getJsPDFConstructor();

      if (constructor) {
        resolve(constructor);
        return;
      }

      if (sourceIndex >= sources.length) {
        reject(
          new Error(
            "jsPDF could not be loaded. Check the internet connection or add jspdf.umd.min.js as a PlayCanvas script asset.",
          ),
        );
        return;
      }

      removeLoader();

      var source = sources[sourceIndex];
      sourceIndex += 1;

      var script = document.createElement("script");

      script.id = "sqJsPdfLoader";
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = source;

      script.onload = function () {
        var loadedConstructor = self._getJsPDFConstructor();

        if (loadedConstructor) {
          resolve(loadedConstructor);
        } else {
          console.warn(
            "[SplatClickQuery] jsPDF loaded but its constructor was not found:",
            source,
          );

          tryNextSource();
        }
      };

      script.onerror = function () {
        console.warn("[SplatClickQuery] Could not load jsPDF from:", source);

        tryNextSource();
      };

      document.head.appendChild(script);
    }

    tryNextSource();
  }).catch(function (error) {
    // Let the user retry after a failed load.
    self._pdfLibraryPromise = null;
    throw error;
  });

  return this._pdfLibraryPromise;
};

// ============================================================
// INPUT HANDLERS
// ============================================================

SplatClickQuery.prototype._onMouseDown = function (event) {
  // While the fullscreen / 360 viewer is open, swallow input so it never reaches
  // the picking or camera-orbit logic underneath the overlay.
  if (this._isFullscreenOpen()) {
    return;
  }

  var screenshotOverlay = document.getElementById("sst-overlay");

  if (screenshotOverlay && screenshotOverlay.classList.contains("active")) {
    return;
  }

  if (this._hitTriggerButton(event.x, event.y)) {
    return;
  }

  if (this._hitPanel(event.x, event.y)) {
    return;
  }

  if (!this._active) {
    return;
  }

  // Middle-drag (or configured button) orbits the camera, like SplatMeasurer.
  if (event.button === this.orbitMouseButton) {
    this._isOrbitDragging = true;
    this._lastDragX = event.x;
    this._lastDragY = event.y;

    if (event.event) {
      event.event.preventDefault();
    }

    return;
  }

  if (event.button !== pc.MOUSEBUTTON_LEFT) {
    return;
  }

  this._lastClickX = event.x;
  this._lastClickY = event.y;

  this._query(event.x, event.y);
};

SplatClickQuery.prototype._onMouseMove = function (event) {
  if (this._isFullscreenOpen()) {
    return;
  }

  if (!this._active || !this._isOrbitDragging) {
    return;
  }

  var dx = event.x - this._lastDragX;
  var dy = event.y - this._lastDragY;

  this._lastDragX = event.x;
  this._lastDragY = event.y;

  var camScript = this._getCameraManagerScript();

  if (camScript && typeof camScript.updateAngles === "function") {
    camScript.updateAngles(dx, dy);
  } else {
    var cameraEntity = this._getCameraEntity();

    if (cameraEntity) {
      var eulers = cameraEntity.getEulerAngles();
      eulers.y += dx * this.orbitDragSensitivity;
      eulers.x += dy * this.orbitDragSensitivity;
      eulers.x = pc.math.clamp(eulers.x, -90, 90);
      cameraEntity.setEulerAngles(eulers);
    }
  }
};

SplatClickQuery.prototype._onMouseUp = function (event) {
  if (event.button === this.orbitMouseButton) {
    this._isOrbitDragging = false;
  }
};

SplatClickQuery.prototype._onTouchStart = function (event) {
  if (this._isFullscreenOpen()) {
    return;
  }

  if (!event.touches || event.touches.length === 0) {
    return;
  }

  var screenshotOverlay = document.getElementById("sst-overlay");

  if (screenshotOverlay && screenshotOverlay.classList.contains("active")) {
    return;
  }

  var touch = event.touches[0];

  if (this._hitTriggerButton(touch.x, touch.y)) {
    return;
  }

  if (this._hitPanel(touch.x, touch.y)) {
    return;
  }

  if (!this._active) {
    return;
  }

  this._lastClickX = touch.x;
  this._lastClickY = touch.y;

  this._query(touch.x, touch.y);
};

SplatClickQuery.prototype._hitPanel = function (x, y) {
  var panel = document.getElementById("sqPanel");

  if (!panel || !panel.classList.contains("open")) {
    return false;
  }

  var bounds = panel.getBoundingClientRect();

  var insidePanel =
    x >= bounds.left &&
    x <= bounds.right &&
    y >= bounds.top &&
    y <= bounds.bottom;

  if (insidePanel) {
    return true;
  }

  // The close tab sticks out past the panel's left edge.
  var closeTab = document.getElementById("sqClose");

  if (closeTab) {
    var closeBounds = closeTab.getBoundingClientRect();

    return (
      x >= closeBounds.left &&
      x <= closeBounds.right &&
      y >= closeBounds.top &&
      y <= closeBounds.bottom
    );
  }

  return false;
};

SplatClickQuery.prototype._hitTriggerButton = function (x, y) {
  var button = document.getElementById("sqTriggerBtn");

  if (!button) {
    return false;
  }

  var bounds = button.getBoundingClientRect();

  return (
    x >= bounds.left &&
    x <= bounds.right &&
    y >= bounds.top &&
    y <= bounds.bottom
  );
};

// ============================================================
// ACTIVATE / DEACTIVATE PICKING
// ============================================================

SplatClickQuery.prototype._setActive = function (active) {
  this._syncActiveAcrossInstances(active);
  this._active = active;

  var button = document.getElementById("sqTriggerBtn");
  var hint = document.getElementById("sqHint");

  if (!button) {
    this._setCameraToolLock(active);
    return;
  }

  if (active) {
    button.style.background = "rgba(47, 123, 255, 0.35)";

    button.style.borderColor = "rgba(47, 123, 255, 0.75)";

    button.title = "Click mode is active. Click again to disable.";

    if (hint) {
      hint.style.opacity = "1";
    }

    // Stop cameraManager left-drag orbit and exit waypoint-hover travel.
    this._setCameraToolLock(true);
  } else {
    button.style.background = "rgba(13, 15, 20, 0.88)";

    button.style.borderColor = "rgba(255, 255, 255, 0.13)";

    button.title = "Enable splat click mode";

    if (hint) {
      hint.style.opacity = "0";
    }

    var dot = document.getElementById("sqDot");

    if (dot) {
      dot.style.display = "none";
    }

    // Remove the 3D surface marker when leaving click mode.
    this._clearMarker();

    this._isOrbitDragging = false;

    this._setCameraToolLock(false);
  }
};

// ============================================================
// SCREEN POINT TO 3D POINT
// ============================================================

// Mouse/touch coordinates are in CSS pixels, but the picker is sized to the
// backbuffer (device pixels). On HiDPI screens these differ by devicePixelRatio.
// Scale the cursor coordinates into the picker's resolution so the picked point
// matches the cursor.
SplatClickQuery.prototype._getPickerCoords = function (x, y) {
  var device = this.app.graphicsDevice;
  var canvas = device.canvas;

  var scaleX =
    canvas && canvas.clientWidth ? device.width / canvas.clientWidth : 1;

  var scaleY =
    canvas && canvas.clientHeight ? device.height / canvas.clientHeight : 1;

  return { x: x * scaleX, y: y * scaleY };
};

// Fallback only: sample a fixed distance along the click ray. Used when the GPU
// depth pick returns nothing (e.g. clicking empty space / sky).
SplatClickQuery.prototype._approxRayPoint = function (
  cameraEntity,
  screenX,
  screenY,
) {
  var nearPoint = new pc.Vec3();
  var farPoint = new pc.Vec3();

  cameraEntity.camera.screenToWorld(screenX, screenY, 1, nearPoint);
  cameraEntity.camera.screenToWorld(screenX, screenY, 50, farPoint);

  var ratio = this.sampleDepth / 50;

  return new pc.Vec3(
    nearPoint.x + (farPoint.x - nearPoint.x) * ratio,
    nearPoint.y + (farPoint.y - nearPoint.y) * ratio,
    nearPoint.z + (farPoint.z - nearPoint.z) * ratio,
  );
};

// Convert a world-space surface point into the splat's local space (which is the
// COLMAP coordinate system) and send it to the API.
SplatClickQuery.prototype._sendWorldPoint = function (
  worldPosition,
  screenX,
  screenY,
) {
  // Anchor a 3D marker on the splat surface so it stays in place while orbiting,
  // and hide the temporary HTML dot used for instant feedback.
  this._placeMarker(worldPosition);

  var htmlDot = document.getElementById("sqDot");
  if (htmlDot) {
    htmlDot.style.display = "none";
  }

  var colmapPosition = this._worldToColmap(worldPosition);

  // Keep the raw world point so calibration pairs (sqCal.add) use the exact same
  // coordinate space the query is sent in.
  this._lastWorld = worldPosition.clone();

  // When useServerCalibration is on, we send RAW WORLD coordinates and let the
  // server's fitted Procrustes transform do everything. Otherwise we send the
  // client-side COLMAP estimate (entity inverse + scale). Whichever we send, the
  // view direction is computed in the SAME frame so it stays consistent.
  var useRaw = !!this.useServerCalibration;
  var sendPoint = useRaw ? worldPosition.clone() : colmapPosition;

  var cameraColmap = null;
  var viewDirection = null;

  if (this.viewFilterEnabled) {
    var cameraEntity = this._getCameraEntity();

    if (cameraEntity) {
      var cameraWorld = cameraEntity.getPosition().clone();

      cameraColmap = useRaw ? cameraWorld : this._worldToColmap(cameraWorld);

      viewDirection = new pc.Vec3().sub2(sendPoint, cameraColmap);

      if (viewDirection.length() > 1e-6) {
        viewDirection.normalize();
      } else {
        viewDirection = null;
      }
    }
  }

  this._lastCameraColmap = cameraColmap;
  this._lastViewDirection = viewDirection;
  this._lastQueryColmap = colmapPosition.clone();

  this._callAPI(sendPoint.x, sendPoint.y, sendPoint.z);
};

// Convert a world-space point into COLMAP coordinates: undo the splat entity's
// world transform to get splat-local space, then apply the configured
// local->COLMAP similarity transform. Reused for both the clicked point and the
// camera position so their directions are consistent.
SplatClickQuery.prototype._worldToColmap = function (worldPoint) {
  var local = worldPoint.clone();

  var splatEntity = this.app.root.findByName(this.splatEntityName);

  if (splatEntity) {
    var inverseTransform = new pc.Mat4();

    inverseTransform.copy(splatEntity.getWorldTransform()).invert();

    inverseTransform.transformPoint(worldPoint, local);
  } else {
    console.warn(
      '[SplatClickQuery] Splat entity "' +
        this.splatEntityName +
        '" was not found. Raw world coordinates will be used.',
    );
  }

  return this._localToColmap(local);
};

// Map a splat-local point to COLMAP coordinates using the configured similarity
// transform:  colmap = coordRotation * (coordScale * local) + coordOffset.
SplatClickQuery.prototype._localToColmap = function (localPoint) {
  var scale =
    typeof this.coordinateScale === "number" ? this.coordinateScale : 1;

  var result = new pc.Vec3(
    localPoint.x * scale,
    localPoint.y * scale,
    localPoint.z * scale,
  );

  var rot = this.coordinateRotation;
  var hasRot = rot && (rot.x !== 0 || rot.y !== 0 || rot.z !== 0);

  if (hasRot) {
    var q = new pc.Quat();
    q.setFromEulerAngles(rot.x, rot.y, rot.z);
    q.transformVector(result, result);
  }

  var offset = this.coordinateOffset;

  if (offset) {
    result.x += offset.x;
    result.y += offset.y;
    result.z += offset.z;
  }

  return result;
};

// Return the camera that is actually rendering the view. The scene has a
// disabled "Camera" entity and the real one is "Camera-Main" (it owns
// cameraManager + renderSceneDepthMap). Using the wrong camera makes every
// picked point come from a different viewpoint.
SplatClickQuery.prototype._getCameraEntity = function () {
  var main = this.app.root.findByName("Camera-Main");

  if (main && main.camera && main.enabled && main.camera.enabled) {
    return main;
  }

  var active = this.app.root.find(function (node) {
    return node.camera && node.enabled && node.camera.enabled;
  });

  if (active && active.length > 0) {
    return active[0];
  }

  return this.app.root.findByName("Camera");
};

SplatClickQuery.prototype._query = function (screenX, screenY) {
  var self = this;

  var cameraEntity = this._getCameraEntity();

  if (!cameraEntity || !cameraEntity.camera) {
    console.warn("[SplatClickQuery] No active camera entity was found.");

    return;
  }

  // Pin the dot to the exact screen position that was clicked, then show the
  // spinner immediately while the async depth read happens.
  this._placeDot(screenX, screenY);

  this._showLoading();

  // Preferred path: read the real surface depth at the clicked pixel.
  if (this._picker && typeof this._picker.getWorldPointAsync === "function") {
    var worldLayer = this.app.scene.layers.getLayerByName("World");

    var layers = worldLayer ? [worldLayer] : this.app.scene.layers.layerList;

    try {
      this._picker.prepare(cameraEntity.camera, this.app.scene, layers);

      var coords = this._getPickerCoords(screenX, screenY);

      this._picker
        .getWorldPointAsync(coords.x, coords.y)
        .then(function (hitPoint) {
          if (hitPoint) {
            self._sendWorldPoint(hitPoint, screenX, screenY);
          } else {
            // Clicked empty space — fall back to the ray approximation.
            self._sendWorldPoint(
              self._approxRayPoint(cameraEntity, screenX, screenY),
              screenX,
              screenY,
            );
          }
        })
        .catch(function (error) {
          console.warn(
            "[SplatClickQuery] Depth pick failed, using ray fallback:",
            error && error.message ? error.message : error,
          );

          self._sendWorldPoint(
            self._approxRayPoint(cameraEntity, screenX, screenY),
            screenX,
            screenY,
          );
        });

      return;
    } catch (error) {
      console.warn(
        "[SplatClickQuery] Picker unavailable, using ray fallback:",
        error && error.message ? error.message : error,
      );
    }
  }

  // Fallback path.
  this._sendWorldPoint(
    this._approxRayPoint(cameraEntity, screenX, screenY),
    screenX,
    screenY,
  );
};

// ============================================================
// API REQUEST
// ============================================================

SplatClickQuery.prototype._callAPI = function (x, y, z, mode) {
  var self = this;
  var append = mode === "more";
  var refresh = mode === "refresh";
  var pageSize = this.maxResults || 6;

  if (!append && !refresh) {
    this._lastQueryCoords = null;
    this._currentMaxResults = pageSize;
    this._hasMore = false;
  }

  if (append) {
    this._currentMaxResults = (this._currentMaxResults || pageSize) + pageSize;
  }

  var baseURL = String(this.apiBase || "").replace(/\/$/, "");

  var url = baseURL + "/query";

  var payload = {
    x: Number(x),
    y: Number(y),
    z: Number(z),
    max_results: this._currentMaxResults || pageSize,
    center_threshold: this.centerThreshold,
    include_images: true,
    add_marker: !!this._addMarker,
    offset: 0,
  };

  // Attach the viewer's camera pose so the API can bias results toward photos
  // taken from a similar viewing angle. Harmless if the API ignores these keys.
  if (this.viewFilterEnabled && this._lastViewDirection) {
    payload.view_direction = [
      this._lastViewDirection.x,
      this._lastViewDirection.y,
      this._lastViewDirection.z,
    ];

    payload.max_view_angle = this.maxViewAngle;

    if (this._lastCameraColmap) {
      payload.camera_position = [
        this._lastCameraColmap.x,
        this._lastCameraColmap.y,
        this._lastCameraColmap.z,
      ];
    }
  }

  if (append) {
    this._updateFetchMoreUI(true, true);
  }

  fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },

    body: JSON.stringify(payload),
  })
    .then(function (response) {
      if (!response.ok) {
        throw new Error(
          "HTTP " + response.status + ". Check the API/ngrok URL.",
        );
      }

      return response.json();
    })
    .then(function (data) {
      if (append) {
        var prevCount = self._imageData.length;
        self._showResults(data, x, y, z);
        if (prevCount > 0 && self._imageData.length > prevCount) {
          self._scrollToNewImages(prevCount);
        }
      } else {
        self._showResults(data, x, y, z);
      }
    })
    .catch(function (error) {
      if (append) {
        self._currentMaxResults = Math.max(
          pageSize,
          (self._currentMaxResults || pageSize) - pageSize,
        );
        self._updateFetchMoreUI(self._hasMore, false);
        alert("Fetch more failed: " + error.message);
      } else {
        self._showError(error.message);
      }
    });
};

// ============================================================
// FETCH MORE PAGINATION
// ============================================================

SplatClickQuery.prototype._onFetchMore = function () {
  if (!this._lastQueryCoords) {
    return;
  }

  var coords = this._lastQueryCoords;

  this._callAPI(coords.x, coords.y, coords.z, "more");
};

SplatClickQuery.prototype._scrollToNewImages = function (startIndex) {
  var scroll = document.getElementById("sqScroll");

  if (!scroll) {
    return;
  }

  var firstNewCard = scroll.querySelector(
    '.sq-card[data-idx="' + startIndex + '"]',
  );

  if (!firstNewCard) {
    return;
  }

  requestAnimationFrame(function () {
    var paddingTop =
      parseFloat(window.getComputedStyle(scroll).paddingTop) || 0;

    var targetTop =
      firstNewCard.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      scroll.scrollTop -
      paddingTop;

    scroll.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  });
};

SplatClickQuery.prototype._updateFetchMoreUI = function (hasMore, loading) {
  var button = document.getElementById("sqFetchMore");

  if (!button) {
    return;
  }

  var step = this.maxResults || 6;

  if (hasMore) {
    button.style.display = "block";
    button.disabled = !!loading;
    button.textContent = loading ? "Loading..." : "Fetch More (+" + step + ")";
  } else {
    button.style.display = "none";
    button.disabled = false;
    button.textContent = "Fetch More";
  }
};

// ============================================================
// CLICK MARKER
// ============================================================

SplatClickQuery.prototype._placeDot = function (x, y) {
  var dot = document.getElementById("sqDot");

  if (!dot) {
    return;
  }

  dot.style.left = x + "px";
  dot.style.top = y + "px";
  dot.style.display = "block";
};

// ============================================================
// WORLD-SPACE MARKER (pinned to the splat surface)
// Mirrors SplatMeasurer.createDebugMarker: a 3D sphere placed at the picked
// world point so it stays in place as the camera orbits, instead of an HTML dot
// stuck to screen pixels.
// ============================================================

SplatClickQuery.prototype._getWorldLayerId = function () {
  var layer = this.app.scene.layers.getLayerByName("World");

  return layer ? layer.id : pc.LAYERID_WORLD;
};

SplatClickQuery.prototype._placeMarker = function (worldPosition) {
  if (!this._marker) {
    this._marker = new pc.Entity("sqWorldMarker");

    this._marker.addComponent("render", { type: "sphere" });

    var material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(0.18, 0.48, 1.0);
    material.emissive = new pc.Color(0.18, 0.48, 1.0);
    material.useLighting = false;
    material.update();

    this._marker.render.material = material;
    this._marker.render.layers = [this._getWorldLayerId()];

    this.app.root.addChild(this._marker);
  }

  this._marker.enabled = true;
  this._marker.setPosition(worldPosition);

  // Keep the on-screen size roughly constant regardless of distance so the
  // marker is always visible but not huge.
  var cameraEntity = this._getCameraEntity();

  var size = 0.05;

  if (cameraEntity) {
    var distance = cameraEntity.getPosition().distance(worldPosition);
    size = pc.math.clamp(distance * 0.012, 0.02, 0.5);
  }

  this._marker.setLocalScale(size, size, size);
};

SplatClickQuery.prototype._clearMarker = function () {
  if (this._marker) {
    this._marker.enabled = false;
  }
};

// ============================================================
// BUILD USER INTERFACE
// ============================================================

SplatClickQuery.prototype._buildUI = function () {
  this._addFont();
  this._addStyles();
  this._addPanel();
  this._addFullscreenModal();
  this._addTriggerButton();
  this._addDot();
  this._addHint();
  this._addReopenButton();
  this._wireUIEvents();
};

SplatClickQuery.prototype._addFont = function () {
  var font = document.createElement("link");

  font.id = "sqFont";
  font.rel = "stylesheet";

  font.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";

  document.head.appendChild(font);
};

SplatClickQuery.prototype._addStyles = function () {
  var style = document.createElement("style");

  style.id = "sqStyle";

  style.textContent = `
        #sqPanel,
        #sqPanel *,
        #sqPanel *::before,
        #sqPanel *::after {
            box-sizing: border-box;
        }

        #sqPanel {
            position: fixed;
            top: 0;
            right: 0;
            width: 336px;
            height: 100vh;
            max-height: 100vh;
            z-index: 2147483600;
            display: flex;
            flex-direction: column;
            overflow-x: visible;
            overflow-y: hidden;
            color: #e8eaf0;
            background: #0c0e13;
            border-left: 1px solid rgba(255,255,255,0.08);
            box-shadow: -18px 0 48px rgba(0,0,0,0.45);
            font-family: Inter, Arial, sans-serif;
            transform: translateX(100%);
            transition: transform 0.32s cubic-bezier(0.4,0,0.2,1);
        }

        #sqPanel.open {
            transform: translateX(0);
        }

        #sqHeader {
            position: relative;
            flex-shrink: 0;
            padding: 22px 20px 18px;
            background: linear-gradient(180deg, #14171f 0%, #12141b 100%);
            border-bottom: 1px solid rgba(255,255,255,0.07);
        }

        #sqTitle {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 0 0 5px 0;
            color: #ffffff;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: -0.01em;
            line-height: 1.3;
        }

        #sqTitle::before {
            content: "";
            width: 7px;
            height: 7px;
            flex-shrink: 0;
            background: #2f7bff;
            border-radius: 50%;
            box-shadow: 0 0 8px rgba(47,123,255,0.9);
        }

        #sqSubtitle {
            margin: 0;
            color: rgba(255,255,255,0.4);
            font-size: 11.5px;
            line-height: 1.5;
        }

        #sqClose {
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
            font-family: Inter, Arial, sans-serif;
            opacity: 0;
            pointer-events: none;
            transform: translateY(-50%);
            transition: color 0.15s ease, background 0.15s ease, opacity 0.2s ease;
        }

        #sqPanel.open #sqClose {
            opacity: 1;
            pointer-events: auto;
        }

        #sqClose:hover {
            color: #ffffff;
            background: #1a1e28;
        }

        #sqClose svg {
            display: block;
            pointer-events: none;
        }

        #sqCalPanel,
        #sqCalAuthPanel {
            flex-shrink: 0;
            margin: 14px 18px 0;
            padding: 12px 14px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
        }

        #sqCalAuthInputs {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 8px;
        }

        #sqCalAuthInputs input {
            width: 100%;
            min-width: 0;
            padding: 8px;
            color: #e8eaf0;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 7px;
            font-family: Inter, Arial, sans-serif;
            font-size: 12px;
        }

        #sqCalAuthInputs input::placeholder {
            color: rgba(255,255,255,0.3);
        }

        #sqCalAuthInputs input:focus {
            outline: none;
            border-color: rgba(47,123,255,0.6);
            background: rgba(255,255,255,0.08);
        }

        #sqCalAuthError {
            display: none;
            margin-bottom: 8px;
            color: #f87171;
            font-size: 11px;
            line-height: 1.4;
        }

        #sqCalAuthButtons button {
            width: 100%;
            padding: 9px;
            color: #ffffff;
            background: rgba(47,123,255,0.25);
            border: 1px solid rgba(47,123,255,0.5);
            border-radius: 7px;
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 12px;
            font-weight: 600;
            transition: background 0.15s ease, opacity 0.15s ease;
        }

        #sqCalAuthButtons button:hover:not(:disabled) {
            background: rgba(47,123,255,0.4);
        }

        #sqCalAuthButtons button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .sq-cal-label {
            margin-bottom: 8px;
            color: rgba(255,255,255,0.4);
            font-size: 9.5px;
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        #sqCalInputs {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }

        #sqCalInputs input {
            width: 100%;
            min-width: 0;
            padding: 8px;
            color: #e8eaf0;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 7px;
            font-family: Inter, Arial, sans-serif;
            font-size: 12px;
        }

        #sqCalInputs input::placeholder {
            color: rgba(255,255,255,0.3);
        }

        #sqCalInputs input:focus {
            outline: none;
            border-color: rgba(47,123,255,0.6);
            background: rgba(255,255,255,0.08);
        }

        #sqCalButtons {
            display: flex;
            gap: 8px;
        }

        #sqCalButtons button {
            flex: 1;
            padding: 9px;
            color: #ffffff;
            background: rgba(47,123,255,0.25);
            border: 1px solid rgba(47,123,255,0.5);
            border-radius: 7px;
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 12px;
            font-weight: 600;
            transition: background 0.15s ease, opacity 0.15s ease;
        }

        #sqCalButtons button:hover:not(:disabled) {
            background: rgba(47,123,255,0.4);
        }

        #sqCalButtons button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        #sqCalButtons button.sq-cal-success {
            background: rgba(34,197,94,0.35);
            border-color: rgba(34,197,94,0.6);
        }

        #sqCalButtons button.sq-cal-error {
            background: rgba(248,113,113,0.35);
            border-color: rgba(248,113,113,0.6);
        }

        #sqSelectAll {
            flex-shrink: 0;
            width: calc(100% - 36px);
            margin: 14px 18px 0;
            padding: 11px;
            color: #ffffff;
            background: linear-gradient(
                135deg,
                #2f7bff 0%,
                #1a5fd4 100%
            );
            border: 0;
            border-radius: 9px;
            box-shadow: 0 4px 14px rgba(47,123,255,0.25);
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.01em;
            transition: opacity 0.15s ease, transform 0.12s ease;
        }

        #sqSelectAll:hover {
            opacity: 0.88;
        }

        #sqSelectAll:active {
            transform: scale(0.98);
        }

        #sqScrollWrap {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        #sqScroll {
            flex: 1;
            min-height: 0;
            width: 100%;
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-auto-rows: max-content;
            align-content: start;
            align-items: start;
            gap: 12px;
            padding: 16px 18px;
            overflow-x: hidden;
            overflow-y: auto;
            overscroll-behavior: contain;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.28) transparent;
            -webkit-overflow-scrolling: touch;
        }

        #sqScroll::-webkit-scrollbar {
            width: 8px;
        }

        #sqScroll::-webkit-scrollbar-track {
            background: rgba(255,255,255,0.04);
            border-radius: 10px;
        }

        #sqScroll::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.28);
            border-radius: 10px;
        }

        #sqScroll::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.4);
        }

        .sq-card {
            position: relative;
            width: 100%;
            min-width: 0;
            align-self: start;
            overflow: hidden;
            background: #171b24;
            border: 1.5px solid rgba(255,255,255,0.07);
            border-radius: 12px;
            cursor: pointer;
            user-select: none;
            transition:
                border-color 0.15s ease,
                box-shadow 0.15s ease,
                transform 0.12s ease,
                background 0.15s ease;
        }

        .sq-card:hover {
            border-color: rgba(47,123,255,0.5);
            box-shadow: 0 6px 18px rgba(0,0,0,0.35);
            transform: translateY(-2px);
        }

        .sq-card.selected {
            background: #142035;
            border-color: #2f7bff;
            box-shadow: 0 0 0 1px rgba(47,123,255,0.4), 0 6px 18px rgba(47,123,255,0.15);
        }

        .sq-card-image {
            width: 100%;
            height: auto;
            aspect-ratio: 1 / 1;
            display: block;
            object-fit: cover;
            flex-shrink: 0;
            background: #11141b;
            cursor: pointer;
        }

        .sq-card-no-image {
            width: 100%;
            height: auto;
            aspect-ratio: 1 / 1;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255,255,255,0.22);
            background: #1e2230;
            font-size: 10.5px;
            font-weight: 500;
        }

        .sq-card-name {
            min-width: 0;
            padding: 9px 10px;
            overflow: hidden;
            color: rgba(255,255,255,0.42);
            font-size: 10.5px;
            font-weight: 500;
            line-height: 1.4;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .sq-card.selected .sq-card-name {
            color: rgba(255,255,255,0.78);
        }

        .sq-check {
            position: absolute;
            top: 8px;
            left: 8px;
            width: 19px;
            height: 19px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.55);
            border: 2px solid rgba(255,255,255,0.4);
            border-radius: 5px;
            pointer-events: auto;
            cursor: pointer;
            transition: 0.15s ease;
            z-index: 10;
        }

        .sq-check:hover {
            border-color: rgba(255,255,255,0.7);
        }

        .sq-card.selected .sq-check {
            background: #2f7bff;
            border-color: #2f7bff;
        }

        .sq-check::after {
            content: "";
            width: 8px;
            height: 5px;
            display: none;
            border-bottom: 2px solid #ffffff;
            border-left: 2px solid #ffffff;
            transform: rotate(-45deg) translate(1px,-1px);
        }

        .sq-card.selected .sq-check::after {
            display: block;
        }

        .sq-rank {
            position: absolute;
            top: 8px;
            right: 8px;
            padding: 3px 6px;
            color: rgba(255,255,255,0.7);
            background: rgba(0,0,0,0.6);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 5px;
            font-size: 9.5px;
            font-weight: 700;
            letter-spacing: 0.01em;
            pointer-events: none;
        }

        .sq-rank.top {
            color: #ffffff;
            background: #2f7bff;
            border-color: #2f7bff;
            box-shadow: 0 2px 8px rgba(47,123,255,0.45);
        }

        #sqState {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 14px;
            padding: 32px 24px;
            color: rgba(255,255,255,0.32);
            font-size: 13px;
            line-height: 1.65;
            text-align: center;
        }

        .sq-spinner {
            width: 34px;
            height: 34px;
            border: 3px solid rgba(255,255,255,0.08);
            border-top-color: #2f7bff;
            border-radius: 50%;
            animation: sqSpin 0.65s linear infinite;
        }

        @keyframes sqSpin {
            to {
                transform: rotate(360deg);
            }
        }

        #sqFooter {
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            gap: 9px;
            padding: 14px 18px;
            background: #0c0e13;
            border-top: 1px solid rgba(255,255,255,0.07);
        }

        #sqFetchMore {
            width: 100%;
            padding: 11px;
            color: rgba(255,255,255,0.85);
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.16);
            border-radius: 9px;
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 13px;
            font-weight: 600;
            transition:
                opacity 0.15s ease,
                background 0.15s ease,
                border-color 0.15s ease;
        }

        #sqFetchMore:hover:not(:disabled) {
            background: rgba(255,255,255,0.07);
            border-color: rgba(255,255,255,0.32);
        }

        #sqFetchMore:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        #sqExportPDF,
        #sqExport {
            width: 100%;
            padding: 13px;
            color: #ffffff;
            border: 0;
            border-radius: 9px;
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.01em;
            transition: opacity 0.15s ease, transform 0.12s ease;
        }

        #sqExportPDF {
            display: none;
            background: linear-gradient(
                135deg,
                #f59e0b 0%,
                #d97706 100%
            );
            box-shadow: 0 4px 14px rgba(245,158,11,0.22);
        }

        #sqExport {
            background: linear-gradient(
                135deg,
                #22c55e 0%,
                #16a34a 100%
            );
            box-shadow: 0 4px 14px rgba(34,197,94,0.22);
        }

        #sqExportPDF:hover:not(:disabled),
        #sqExport:hover:not(:disabled) {
            opacity: 0.88;
        }

        #sqExportPDF:active:not(:disabled),
        #sqExport:active:not(:disabled) {
            transform: scale(0.98);
        }

        #sqExportPDF:disabled,
        #sqExport:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        #sqTriggerBtn {
            position: fixed;
            bottom: 84px;
            left: 24px;
            z-index: 2147483640;
            height: 46px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 0 16px;
            background: rgba(13,15,20,0.88);
            border: 1px solid rgba(255,255,255,0.13);
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            backdrop-filter: blur(12px);
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 13px;
            font-weight: 600;
            color: rgba(255,255,255,0.9);
            white-space: nowrap;
            transition:
                background 0.15s ease,
                border-color 0.15s ease,
                transform 0.12s ease;
        }

        #sqTriggerBtn:hover {
            background: rgba(47,123,255,0.2);
            border-color: rgba(47,123,255,0.42);
            transform: scale(1.04);
        }

        #sqTriggerBtn:active {
            transform: scale(0.97);
        }

        #sqTriggerBtn svg {
            pointer-events: none;
        }

        #sqDot {
            position: fixed;
            z-index: 2147483590;
            width: 14px;
            height: 14px;
            display: none;
            background: #2f7bff;
            border: 2.5px solid #ffffff;
            border-radius: 50%;
            box-shadow:
                0 0 0 3px rgba(47,123,255,0.35),
                0 0 14px rgba(47,123,255,0.7);
            pointer-events: none;
            transform: translate(-50%,-50%);
            animation: sqDotPop 0.2s ease-out;
        }

        @keyframes sqDotPop {
            from {
                opacity: 0.4;
                transform: translate(-50%,-50%) scale(0.4);
            }

            to {
                opacity: 1;
                transform: translate(-50%,-50%) scale(1);
            }
        }

        #sqHint {
            position: fixed;
            bottom: 20px;
            left: 50%;
            z-index: 2147483590;
            padding: 9px 18px;
            color: rgba(255,255,255,0.5);
            background: rgba(10,12,18,0.84);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
            font-family: Inter, Arial, sans-serif;
            font-size: 12px;
            letter-spacing: 0.02em;
            opacity: 0;
            pointer-events: none;
            transform: translateX(-50%);
            transition: opacity 0.3s ease;
            white-space: nowrap;
        }

        #sqReopenBtn {
            position: fixed;
            top: 50%;
            right: 0;
            z-index: 2147483595;
            display: none;
            padding: 14px 8px;
            color: rgba(255,255,255,0.55);
            background: #13161e;
            border: 1px solid rgba(255,255,255,0.1);
            border-right: 0;
            border-radius: 8px 0 0 8px;
            cursor: pointer;
            font-family: Inter, Arial, sans-serif;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.06em;
            text-orientation: mixed;
            transform: translateY(-50%);
            transition: 0.15s ease;
            writing-mode: vertical-rl;
        }

        #sqReopenBtn:hover {
            color: #ffffff;
            background: #1a1e28;
        }

        #sqFullscreenModal {
            position: fixed;
            inset: 0;
            z-index: 2147483646;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 50px;
            background: rgba(0,0,0,0.95);
            opacity: 0;
            transition: opacity 0.2s ease;
        }

        #sqFullscreenModal.open {
            display: flex;
            opacity: 1;
        }

        #sqFullscreenImg {
            max-width: 94vw;
            max-height: 92vh;
            display: block;
            object-fit: contain;
            border-radius: 6px;
            animation: sqImageZoom 0.25s ease-out;
        }

        /* 360 panorama viewer inside the fullscreen modal */
        #sqPano {
            display: none;
            position: absolute;
            inset: 40px;
            border-radius: 8px;
            overflow: hidden;
            background: #000;
        }
        #sqFullscreenModal.pano #sqFullscreenImg { display: none; }
        #sqFullscreenModal.pano #sqPano { display: block; }
        #sqPanoHint {
            display: none;
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 3;
            padding: 7px 14px;
            color: rgba(255,255,255,0.75);
            background: rgba(10,12,18,0.72);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 20px;
            font-family: Inter, Arial, sans-serif;
            font-size: 12px;
            pointer-events: none;
        }
        #sqFullscreenModal.pano #sqPanoHint { display: block; }
        /* marker for the clicked point inside the panorama */
        .sq-pt-hotspot {
            width: 26px;
            height: 26px;
            margin: -13px 0 0 -13px;
            border: 3px solid #4fdc82;
            border-radius: 50%;
            box-shadow: 0 0 0 2px rgba(0,0,0,0.7), 0 0 12px #4fdc82;
        }

        @keyframes sqImageZoom {
            from {
                opacity: 0.6;
                transform: scale(0.92);
            }

            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        #sqFullscreenClose {
            position: absolute;
            top: 24px;
            right: 24px;
            z-index: 2;
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            color: #ffffff;
            background: rgba(0,0,0,0.6);
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            cursor: pointer;
            font-size: 28px;
            line-height: 1;
            transition: 0.15s ease;
        }

        #sqFullscreenClose:hover {
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.65);
            transform: scale(1.08);
        }

        #sqFullscreenPrev,
        #sqFullscreenNext {
            position: absolute;
            top: 50%;
            z-index: 2;
            width: 52px;
            height: 52px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            color: #ffffff;
            background: rgba(0,0,0,0.6);
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            cursor: pointer;
            font-size: 32px;
            line-height: 1;
            transform: translateY(-50%);
            transition: 0.15s ease;
        }

        #sqFullscreenPrev {
            left: 24px;
        }

        #sqFullscreenNext {
            right: 24px;
        }

        #sqFullscreenPrev:hover,
        #sqFullscreenNext:hover {
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.65);
            transform: translateY(-50%) scale(1.08);
        }

        #sqFullscreenPrev:disabled,
        #sqFullscreenNext:disabled {
            opacity: 0.35;
            cursor: default;
            pointer-events: none;
        }

        #sqFullscreenCounter {
            position: absolute;
            bottom: 24px;
            left: 50%;
            z-index: 2;
            padding: 8px 14px;
            color: rgba(255,255,255,0.92);
            font-size: 13px;
            letter-spacing: 0.02em;
            background: rgba(0,0,0,0.55);
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 999px;
            transform: translateX(-50%);
            pointer-events: none;
            max-width: min(80vw, 420px);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        @media (max-width: 520px) {
            #sqPanel {
                width: min(90vw, 340px);
            }

            #sqFullscreenModal {
                padding: 20px;
            }

            #sqFullscreenClose {
                top: 14px;
                right: 14px;
            }

            #sqFullscreenPrev {
                left: 12px;
                width: 44px;
                height: 44px;
                font-size: 28px;
            }

            #sqFullscreenNext {
                right: 12px;
                width: 44px;
                height: 44px;
                font-size: 28px;
            }

            #sqFullscreenCounter {
                bottom: 14px;
                font-size: 12px;
            }
        }
    `;

  document.head.appendChild(style);
};

SplatClickQuery.prototype._addPanel = function () {
  var panel = document.createElement("div");

  panel.id = "sqPanel";

  panel.innerHTML = `
        <button
            id="sqClose"
            type="button"
            aria-label="Close panel"
            title="Close panel"
        >
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <polyline points="9 6 15 12 9 18"></polyline>
            </svg>
        </button>

        <div id="sqHeader">
            <div id="sqTitle">Images Found</div>

            <div id="sqSubtitle">
                Select images linked with this 3D point
            </div>
        </div>

        <div id="sqCalAuthPanel" style="display:none">
            <div class="sq-cal-label">Sign In</div>
            <div id="sqCalAuthInputs">
                <input
                    type="text"
                    id="sqCalAuthUser"
                    placeholder="Username"
                    autocomplete="username"
                >
                <input
                    type="password"
                    id="sqCalAuthPass"
                    placeholder="Password"
                    autocomplete="current-password"
                >
            </div>
            <div id="sqCalAuthError"></div>
            <div id="sqCalAuthButtons">
                <button id="sqCalAuthLogin" type="button">Login</button>
            </div>
        </div>

        <div id="sqCalPanel" style="display:none">
            <div class="sq-cal-label">Calibration</div>
            <div id="sqCalInputs">
                <input type="number" id="sqCalX" placeholder="X" step="any">
                <input type="number" id="sqCalY" placeholder="Y" step="any">
                <input type="number" id="sqCalZ" placeholder="Z" step="any">
            </div>
            <div id="sqCalButtons">
                <button id="sqCalAdd" type="button">Add</button>
                <button id="sqCalCompute" type="button">Compute</button>
            </div>
        </div>

        <button
            id="sqSelectAll"
            type="button"
            style="display:none"
        >
            Select All
        </button>

        <div id="sqScrollWrap">
            <div id="sqState">
                <div style="font-size:32px">
                    📍
                </div>

                <div>
                    Press the location button<br>
                    then click the splat
                </div>
            </div>

            <div
                id="sqScroll"
                style="display:none"
            ></div>
        </div>

        <div
            id="sqFooter"
            style="display:none"
        >
            <button
                id="sqFetchMore"
                type="button"
                style="display:none"
            >
                Fetch More
            </button>

            <button
                id="sqExportPDF"
                type="button"
            >
                Export as PDF
            </button>

            <button
                id="sqExport"
                type="button"
            >
                Export Selected
            </button>
        </div>
    `;

  document.body.appendChild(panel);
};

SplatClickQuery.prototype._addFullscreenModal = function () {
  var modal = document.createElement("div");

  modal.id = "sqFullscreenModal";

  modal.innerHTML = `
        <button
            id="sqFullscreenClose"
            type="button"
            aria-label="Close fullscreen image"
        >
            ✕
        </button>

        <button
            id="sqFullscreenPrev"
            type="button"
            aria-label="Previous image"
        >
            ‹
        </button>

        <button
            id="sqFullscreenNext"
            type="button"
            aria-label="Next image"
        >
            ›
        </button>

        <div id="sqFullscreenCounter"></div>

        <img
            id="sqFullscreenImg"
            alt="Fullscreen image"
        >

        <div id="sqPano"></div>

        <div id="sqPanoHint">
            360° · drag to look around · scroll to zoom · green ring = clicked point
        </div>
    `;

  document.body.appendChild(modal);
};

SplatClickQuery.prototype._addTriggerButton = function () {
  var button = document.createElement("button");

  button.id = "sqTriggerBtn";
  button.type = "button";
  button.title = "Search Images";

  button.innerHTML = `
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgba(255,255,255,0.88)"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path
                d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"
            ></path>

            <circle
                cx="12"
                cy="10"
                r="3"
            ></circle>
        </svg>
        <span>Search Images</span>
    `;

  document.body.appendChild(button);
};

SplatClickQuery.prototype._addDot = function () {
  var dot = document.createElement("div");

  dot.id = "sqDot";

  document.body.appendChild(dot);
};

SplatClickQuery.prototype._addHint = function () {
  var hint = document.createElement("div");

  hint.id = "sqHint";
  hint.textContent = "Left-click to pick a point · middle-drag to orbit";

  document.body.appendChild(hint);
};

SplatClickQuery.prototype._addReopenButton = function () {
  var button = document.createElement("button");

  button.id = "sqReopenBtn";
  button.type = "button";
  button.textContent = "PHOTOS";

  document.body.appendChild(button);
};

SplatClickQuery.prototype._wireUIEvents = function () {
  var self = this;

  var triggerButton = document.getElementById("sqTriggerBtn");

  var closeButton = document.getElementById("sqClose");

  var reopenButton = document.getElementById("sqReopenBtn");

  var selectAllButton = document.getElementById("sqSelectAll");

  var fetchMoreButton = document.getElementById("sqFetchMore");

  var pdfButton = document.getElementById("sqExportPDF");

  var exportButton = document.getElementById("sqExport");

  var fullscreenModal = document.getElementById("sqFullscreenModal");

  var fullscreenClose = document.getElementById("sqFullscreenClose");

  var fullscreenPrev = document.getElementById("sqFullscreenPrev");

  var fullscreenNext = document.getElementById("sqFullscreenNext");

  var calAddButton = document.getElementById("sqCalAdd");

  var calComputeButton = document.getElementById("sqCalCompute");

  var calAuthLoginButton = document.getElementById("sqCalAuthLogin");

  var calAuthPassInput = document.getElementById("sqCalAuthPass");

  // Keep PlayCanvas/game keyboard listeners from receiving keys while a
  // calibration field is being edited. Do not prevent the default action:
  // W/A/S/D and other characters must still be typed into the input.
  [
    "sqCalAuthUser",
    "sqCalAuthPass",
    "sqCalX",
    "sqCalY",
    "sqCalZ",
  ].forEach(function (id) {
    var input = document.getElementById(id);

    if (!input) {
      return;
    }

    ["keydown", "keyup", "keypress"].forEach(function (eventName) {
      input.addEventListener(eventName, function (event) {
        event.stopPropagation();
      });
    });
  });

  if (calAuthLoginButton) {
    calAuthLoginButton.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      self._handleCalAuthLogin();
    };
  }

  if (calAuthPassInput) {
    calAuthPassInput.onkeydown = function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        self._handleCalAuthLogin();
      }
    };
  }

  triggerButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    var newState = !self._active;

    if (newState) {
      // Tell other tools to disable themselves before we activate.
      window.dispatchEvent(
        new CustomEvent("vroomk:activate-tool", {
          detail: { tool: "splat" },
        }),
      );

      // Robust fallback: directly close the screenshot drawer so it
      // never lingers behind this one, even if its listener didn't fire.
      var sstPanel = document.getElementById("sstPanel");
      if (sstPanel) {
        sstPanel.classList.remove("open");
      }

      var sstOverlay = document.getElementById("sst-overlay");
      if (sstOverlay) {
        sstOverlay.classList.remove("active");
      }
    }

    self._setActive(newState);

    if (newState) {
      self._openPanel();
    } else {
      self._closePanel();
    }
  };

  closeButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._closePanel();
  };

  reopenButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    // Reopening this drawer should close the screenshot drawer.
    window.dispatchEvent(
      new CustomEvent("vroomk:activate-tool", {
        detail: { tool: "splat" },
      }),
    );

    var sstPanel = document.getElementById("sstPanel");
    if (sstPanel) {
      sstPanel.classList.remove("open");
    }

    self._openPanel();
  };

  selectAllButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._selectAll();
  };

  fetchMoreButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._onFetchMore();
  };

  pdfButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._exportPDF();
  };

  exportButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._exportSelected();
  };

  fullscreenClose.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._closeFullscreen();
  };

  fullscreenPrev.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._navigateFullscreen(-1);
  };

  fullscreenNext.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._navigateFullscreen(1);
  };

  fullscreenModal.onclick = function (event) {
    if (event.target === fullscreenModal) {
      self._closeFullscreen();
    }
  };

  calAddButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._handleCalAdd();
  };

  calComputeButton.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    self._handleCalCompute();
  };

  this._escapeHandler = function (event) {
    if (!self._isFullscreenOpen()) {
      return;
    }

    var modal = document.getElementById("sqFullscreenModal");
    var inPano = modal && modal.classList.contains("pano");

    if (event.key === "Escape") {
      self._closeFullscreen();
      return;
    }

    // In the 360 viewer, let the arrow keys pan the panorama (Pannellum handles
    // them) instead of jumping to the previous/next image.
    if (inPano) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      self._navigateFullscreen(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      self._navigateFullscreen(1);
    }
  };

  document.addEventListener("keydown", this._escapeHandler);

  // Ctrl+P (or Cmd+P) toggles the image marker on/off. Prevent the browser
  // print dialog from opening.
  this._markerToggleHandler = function (event) {
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === "p" || event.key === "P")
    ) {
      event.preventDefault();
      event.stopPropagation();
      self._toggleMarker();
    }
  };

  document.addEventListener("keydown", this._markerToggleHandler);

  // Ctrl+Q (or Cmd+Q) toggles the calibration input panel on/off.
  this._calPanelToggleHandler = function (event) {
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key === "q" || event.key === "Q")
    ) {
      event.preventDefault();
      event.stopPropagation();
      self._toggleCalPanel();
    }
  };

  document.addEventListener("keydown", this._calPanelToggleHandler);
};

// ============================================================
// MARKER TOGGLE (Ctrl+P)
// ============================================================

SplatClickQuery.prototype._toggleMarker = function () {
  this._addMarker = !this._addMarker;

  this._showMarkerToast(this._addMarker);

  // If a point has already been queried, refresh the results so the
  // marker change is applied to the currently shown images.
  if (this._lastQueryCoords) {
    var coords = this._lastQueryCoords;
    this._callAPI(coords.x, coords.y, coords.z, "refresh");
  }
};

SplatClickQuery.prototype._showMarkerToast = function (enabled) {
  var toast = document.getElementById("sqMarkerToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "sqMarkerToast";
    toast.style.cssText = [
      "position:fixed",
      "top:20px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "padding:10px 18px",
      "color:#ffffff",
      "background:rgba(13,15,20,0.92)",
      "border:1px solid rgba(255,255,255,0.15)",
      "border-radius:20px",
      "font-family:Inter, Arial, sans-serif",
      "font-size:13px",
      "font-weight:600",
      "backdrop-filter:blur(10px)",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity 0.2s ease",
    ].join(";");

    document.body.appendChild(toast);
  }

  toast.textContent = enabled
    ? "Image marker: ON (Ctrl+P)"
    : "Image marker: OFF (Ctrl+P)";

  toast.style.opacity = "1";

  if (this._markerToastTimeout) {
    window.clearTimeout(this._markerToastTimeout);
  }

  this._markerToastTimeout = window.setTimeout(function () {
    toast.style.opacity = "0";
  }, 1600);
};

// ============================================================
// CALIBRATION PANEL TOGGLE (Ctrl+Q)
// Shows/hides a small panel with X/Y/Z inputs plus Add/Compute buttons that
// call the existing window.sqCal.add(x, y, z) / window.sqCal.compute()
// helpers set up in _setupCalibrationConsole. Each button flashes green on
// success or red on failure based on the resolved/rejected promise.
// ============================================================

SplatClickQuery.prototype._isCalAuthenticated = function () {
  return !!this._calAuthOk;
};

SplatClickQuery.prototype._updateCalPanelVisibility = function () {
  var calPanel = document.getElementById("sqCalPanel");
  var authPanel = document.getElementById("sqCalAuthPanel");

  if (!calPanel || !authPanel) {
    return;
  }

  if (!this._calPanelOpen) {
    calPanel.style.display = "none";
    authPanel.style.display = "none";
    return;
  }

  if (this._isCalAuthenticated()) {
    authPanel.style.display = "none";
    calPanel.style.display = "block";
  } else {
    calPanel.style.display = "none";
    authPanel.style.display = "block";
  }
};

SplatClickQuery.prototype._toggleCalPanel = function () {
  var calPanel = document.getElementById("sqCalPanel");
  var authPanel = document.getElementById("sqCalAuthPanel");

  if (!calPanel || !authPanel) {
    return;
  }

  this._calPanelOpen = !this._calPanelOpen;
  this._updateCalPanelVisibility();
};

SplatClickQuery.prototype._setCalAuthError = function (message) {
  var errorEl = document.getElementById("sqCalAuthError");

  if (!errorEl) {
    return;
  }

  if (message) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
  } else {
    errorEl.textContent = "";
    errorEl.style.display = "none";
  }
};

SplatClickQuery.prototype._authenticateCalUser = function (username, password) {
  var self = this;
  var supabaseURL = String(this.supabaseURL || "").replace(/\/$/, "");
  var supabaseKey = this.supabaseKey || "";

  if (!supabaseURL || !supabaseKey) {
    return Promise.reject(new Error("Supabase credentials missing"));
  }

  return fetch(supabaseURL + "/rest/v1/rpc/verify_auth", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + supabaseKey,
      apikey: supabaseKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_username: username,
      p_password: password,
    }),
  })
    .then(function (response) {
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            "Login setup is missing. Run supabase/auth_verify.sql in the SQL Editor for " +
              supabaseURL,
          );
        }

        throw new Error(
          "HTTP " + response.status + " - " + response.statusText,
        );
      }

      return response.json();
    })
    .then(function (data) {
      if (data === true) {
        self._calAuthOk = true;
        return true;
      }

      throw new Error("Invalid username or password");
    });
};

SplatClickQuery.prototype._handleCalAuthLogin = function () {
  var userInput = document.getElementById("sqCalAuthUser");
  var passInput = document.getElementById("sqCalAuthPass");
  var button = document.getElementById("sqCalAuthLogin");
  var self = this;

  var username = userInput ? String(userInput.value || "").trim() : "";
  var password = passInput ? String(passInput.value || "") : "";

  if (!username || !password) {
    this._setCalAuthError("Enter username and password");
    return;
  }

  this._setCalAuthError("");

  if (button) {
    button.disabled = true;
    button.textContent = "Signing in...";
  }

  this._authenticateCalUser(username, password)
    .then(function () {
      if (passInput) {
        passInput.value = "";
      }

      self._calPanelOpen = true;
      self._updateCalPanelVisibility();
    })
    .catch(function (error) {
      console.error("[SplatClickQuery] Calibration auth failed:", error);
      self._setCalAuthError(
        error && error.message
          ? error.message
          : "Invalid username or password",
      );
    })
    .finally(function () {
      if (button) {
        button.disabled = false;
        button.textContent = "Login";
      }
    });
};

SplatClickQuery.prototype._setCalButtonState = function (
  button,
  state,
  text,
  revertDelay,
) {
  if (!button) {
    return;
  }

  button.classList.remove("sq-cal-success", "sq-cal-error");

  if (state === "success") {
    button.classList.add("sq-cal-success");
  } else if (state === "error") {
    button.classList.add("sq-cal-error");
  }

  if (!button.dataset.originalText) {
    button.dataset.originalText = button.textContent;
  }

  button.textContent = text;

  if (revertDelay) {
    window.setTimeout(function () {
      button.classList.remove("sq-cal-success", "sq-cal-error");
      button.textContent = button.dataset.originalText;
    }, revertDelay);
  }
};

SplatClickQuery.prototype._handleCalAdd = function () {
  var xInput = document.getElementById("sqCalX");
  var yInput = document.getElementById("sqCalY");
  var zInput = document.getElementById("sqCalZ");
  var button = document.getElementById("sqCalAdd");
  var self = this;

  var x = parseFloat(xInput.value);
  var y = parseFloat(yInput.value);
  var z = parseFloat(zInput.value);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    this._setCalButtonState(button, "error", "Fill X, Y, Z", 1500);
    return;
  }

  if (!window.sqCal || typeof window.sqCal.add !== "function") {
    this._setCalButtonState(button, "error", "sqCal missing", 1500);
    return;
  }

  button.disabled = true;

  var result = window.sqCal.add(x, y, z);

  if (!result || typeof result.then !== "function") {
    // sqCal.add() returns early (e.g. no point clicked yet) without a promise.
    this._setCalButtonState(button, "error", "No point yet", 1500);
    button.disabled = false;
    return;
  }

  result
    .then(function () {
      self._setCalButtonState(button, "success", "Success", 1500);
      button.disabled = false;
    })
    .catch(function (error) {
      console.error("[SplatClickQuery] sqCal.add failed:", error);
      self._setCalButtonState(button, "error", "Failed", 1500);
      button.disabled = false;
    });
};

SplatClickQuery.prototype._handleCalCompute = function () {
  var button = document.getElementById("sqCalCompute");
  var self = this;

  if (!window.sqCal || typeof window.sqCal.compute !== "function") {
    this._setCalButtonState(button, "error", "sqCal missing", 1500);
    return;
  }

  button.disabled = true;

  window.sqCal
    .compute()
    .then(function (result) {
      if (result && result.error) {
        self._setCalButtonState(button, "error", "Failed", 1500);
      } else {
        self._setCalButtonState(button, "success", "Success", 1500);
      }

      button.disabled = false;
    })
    .catch(function (error) {
      console.error("[SplatClickQuery] sqCal.compute failed:", error);
      self._setCalButtonState(button, "error", "Failed", 1500);
      button.disabled = false;
    });
};

// ============================================================
// OPEN/CLOSE PANEL
// ============================================================

SplatClickQuery.prototype._openPanel = function () {
  var panel = document.getElementById("sqPanel");
  var reopen = document.getElementById("sqReopenBtn");

  if (panel) {
    panel.classList.add("open");
  }

  if (reopen) {
    reopen.style.display = "none";
  }
};

SplatClickQuery.prototype._closePanel = function () {
  var panel = document.getElementById("sqPanel");
  var reopen = document.getElementById("sqReopenBtn");

  if (panel) {
    panel.classList.remove("open");
  }

  // Keep the reopen tab hidden so nothing lingers on screen once
  // the drawer is closed.
  if (reopen) {
    reopen.style.display = "none";
  }
};

// ============================================================
// LOADING STATE
// ============================================================

SplatClickQuery.prototype._showLoading = function () {
  this._openPanel();

  this._lastQueryCoords = null;
  this._currentMaxResults = this.maxResults || 6;
  this._hasMore = false;
  this._updateFetchMoreUI(false, false);

  var selectAll = document.getElementById("sqSelectAll");

  var footer = document.getElementById("sqFooter");

  var scroll = document.getElementById("sqScroll");

  var state = document.getElementById("sqState");

  selectAll.style.display = "none";
  footer.style.display = "none";
  scroll.style.display = "none";

  state.style.display = "flex";

  state.innerHTML = `
        <div class="sq-spinner"></div>
        <div>Querying API...</div>
    `;
};

// ============================================================
// DISPLAY RESULTS
// ============================================================

SplatClickQuery.prototype._formatCoord = function (value) {
  if (value == null) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  var n = Number(value);
  if (!Number.isFinite(n)) {
    return String(value);
  }
  // Keep full client/COLMAP precision; do not pad with trailing zeros.
  return n.toFixed(14).replace(/0+$/, "").replace(/\.$/, "");
};

SplatClickQuery.prototype._showResults = function (data, x, y, z) {
  var images = Array.isArray(data.images) ? data.images : [];

  this._imageData = images;
  this._selectedIndices = [];

  var state = document.getElementById("sqState");

  var selectAll = document.getElementById("sqSelectAll");

  var footer = document.getElementById("sqFooter");

  var scroll = document.getElementById("sqScroll");

  var pdfButton = document.getElementById("sqExportPDF");

  pdfButton.style.display = "none";
  selectAll.textContent = "Select All";

  if (images.length === 0) {
    state.style.display = "flex";

    state.innerHTML = `
            <div style="font-size:28px">
                🔍
            </div>

            <div>
                No images were found near this point.<br>

                <small
                    style="font-size:11px;opacity:0.6"
                >
                    Try clicking a different area.
                </small>
            </div>
        `;

    selectAll.style.display = "none";
    scroll.style.display = "none";
    footer.style.display = "none";

    this._lastQueryCoords = { x: x, y: y, z: z };
    this._hasMore = false;
    this._updateFetchMoreUI(false, false);

    return;
  }

  state.style.display = "none";
  selectAll.style.display = "block";
  footer.style.display = "flex";
  scroll.style.display = "grid";

  scroll.innerHTML = "";
  scroll.scrollTop = 0;

  var self = this;

  images.forEach(function (imageData, index) {
    var card = self._createImageCard(imageData, index);

    scroll.appendChild(card);
  });

  this._lastQueryCoords = { x: x, y: y, z: z };
  this._hasMore = !!data.has_more;
  this._updateFetchMoreUI(this._hasMore, false);
};

// ============================================================
// CREATE RESULT CARD
// ============================================================

SplatClickQuery.prototype._createImageCard = function (imageData, index) {
  var self = this;

  var filename = imageData.filename || "image_" + (index + 1) + ".jpg";

  var card = document.createElement("div");

  card.className = "sq-card";
  card.dataset.idx = String(index);

  var image = null;

  if (imageData.data_url) {
    image = document.createElement("img");

    image.className = "sq-card-image";
    image.src = imageData.data_url;
    image.alt = filename;
    image.draggable = false;

    image.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();

      // Only show fullscreen if clicking directly on the image, not on checkbox area
      var checkElement = card.querySelector(".sq-check");
      var clickX = event.clientX;
      var clickY = event.clientY;
      var checkBounds = checkElement.getBoundingClientRect();

      // If click is on checkbox area, toggle selection instead
      if (
        clickX >= checkBounds.left &&
        clickX <= checkBounds.right &&
        clickY >= checkBounds.top &&
        clickY <= checkBounds.bottom
      ) {
        self._toggleCardSelection(card, index);
        return;
      }

      self._showFullscreenByIndex(index);
    };

    image.onerror = function () {
      image.style.display = "none";

      var fallback = document.createElement("div");

      fallback.className = "sq-card-no-image";
      fallback.textContent = "Image failed";

      card.insertBefore(fallback, card.firstChild);
    };

    card.appendChild(image);
  } else {
    var noImage = document.createElement("div");

    noImage.className = "sq-card-no-image";
    noImage.textContent = "No image";

    card.appendChild(noImage);
  }

  var check = document.createElement("div");
  check.className = "sq-check";

  check.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();
    self._toggleCardSelection(card, index);
  };

  card.appendChild(check);

  var rank = document.createElement("div");

  var rankValue =
    typeof imageData.rank === "number" ? imageData.rank + 1 : index + 1;

  var isTopRank =
    typeof imageData.rank === "number" ? imageData.rank === 0 : index === 0;

  rank.className = "sq-rank" + (isTopRank ? " top" : "");

  rank.textContent = "#" + rankValue;

  card.appendChild(rank);

  var name = document.createElement("div");

  name.className = "sq-card-name";
  name.textContent = filename;
  name.title = filename;

  card.appendChild(name);

  card.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();

    // Only toggle selection if not clicking on image or checkbox
    var target = event.target;
    if (target !== image && !target.classList.contains("sq-check")) {
      self._toggleCardSelection(card, index);
    }
  };

  return card;
};

// ============================================================
// CARD SELECTION
// ============================================================

SplatClickQuery.prototype._toggleCardSelection = function (card, index) {
  card.classList.toggle("selected");

  var existingPosition = this._selectedIndices.indexOf(index);

  if (card.classList.contains("selected")) {
    if (existingPosition === -1) {
      this._selectedIndices.push(index);
    }
  } else if (existingPosition !== -1) {
    this._selectedIndices.splice(existingPosition, 1);
  }

  this._selectedIndices.sort(function (a, b) {
    return a - b;
  });

  this._updateSelectionUI();
};

SplatClickQuery.prototype._selectAll = function () {
  var cards = Array.prototype.slice.call(
    document.querySelectorAll("#sqScroll .sq-card"),
  );

  if (cards.length === 0) {
    return;
  }

  var allSelected = cards.every(function (card) {
    return card.classList.contains("selected");
  });

  this._selectedIndices = [];

  var self = this;

  cards.forEach(function (card) {
    var index = parseInt(card.dataset.idx, 10);

    if (allSelected) {
      card.classList.remove("selected");
    } else {
      card.classList.add("selected");
      self._selectedIndices.push(index);
    }
  });

  this._selectedIndices.sort(function (a, b) {
    return a - b;
  });

  this._updateSelectionUI();
};

SplatClickQuery.prototype._updateSelectionUI = function () {
  var pdfButton = document.getElementById("sqExportPDF");

  var selectAllButton = document.getElementById("sqSelectAll");

  var cards = Array.prototype.slice.call(
    document.querySelectorAll("#sqScroll .sq-card"),
  );

  var allSelected =
    cards.length > 0 &&
    cards.every(function (card) {
      return card.classList.contains("selected");
    });

  pdfButton.style.display = this._selectedIndices.length > 0 ? "block" : "none";

  selectAllButton.textContent = allSelected ? "Deselect All" : "Select All";
};

// ============================================================
// FULLSCREEN VIEWER
// ============================================================

SplatClickQuery.prototype._isFullscreenOpen = function () {
  var modal = document.getElementById("sqFullscreenModal");

  return !!(modal && modal.classList.contains("open"));
};

SplatClickQuery.prototype._findNavigableIndex = function (
  startIndex,
  direction,
) {
  var index = startIndex + direction;

  while (index >= 0 && index < this._imageData.length) {
    var imageData = this._imageData[index];

    if (imageData && imageData.data_url) {
      return index;
    }

    index += direction;
  }

  return -1;
};

SplatClickQuery.prototype._updateFullscreenNav = function () {
  var prevButton = document.getElementById("sqFullscreenPrev");
  var nextButton = document.getElementById("sqFullscreenNext");
  var counter = document.getElementById("sqFullscreenCounter");

  if (!prevButton || !nextButton || !counter) {
    return;
  }

  var hasPrev =
    this._fullscreenIndex >= 0 &&
    this._findNavigableIndex(this._fullscreenIndex, -1) !== -1;
  var hasNext =
    this._fullscreenIndex >= 0 &&
    this._findNavigableIndex(this._fullscreenIndex, 1) !== -1;

  prevButton.disabled = !hasPrev;
  nextButton.disabled = !hasNext;

  if (
    this._fullscreenIndex >= 0 &&
    this._fullscreenIndex < this._imageData.length
  ) {
    var imageData = this._imageData[this._fullscreenIndex];
    var filename =
      (imageData && imageData.filename) ||
      "image_" + (this._fullscreenIndex + 1) + ".jpg";

    counter.textContent =
      this._fullscreenIndex +
      1 +
      " / " +
      this._imageData.length +
      " · " +
      filename;
    counter.style.display = "block";
  } else {
    counter.textContent = "";
    counter.style.display = "none";
  }
};

// Lazy-load Pannellum (equirectangular 360 viewer) from a CDN the first time a
// 360 image is opened. Returns a promise resolving to window.pannellum.
SplatClickQuery.prototype._loadPannellum = function () {
  if (window.pannellum) {
    return Promise.resolve(window.pannellum);
  }

  if (this._pannellumPromise) {
    return this._pannellumPromise;
  }

  this._pannellumPromise = new Promise(function (resolve, reject) {
    if (!document.getElementById("sqPannellumCss")) {
      var link = document.createElement("link");
      link.id = "sqPannellumCss";
      link.rel = "stylesheet";
      link.href =
        "https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.css";
      document.head.appendChild(link);
    }

    var script = document.createElement("script");
    script.id = "sqPannellumJs";
    script.async = true;
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.js";
    script.onload = function () {
      resolve(window.pannellum);
    };
    script.onerror = function () {
      reject(new Error("Could not load pannellum from CDN"));
    };
    document.head.appendChild(script);
  });

  return this._pannellumPromise;
};

SplatClickQuery.prototype._destroyPano = function () {
  if (this._panoViewer) {
    try {
      this._panoViewer.destroy();
    } catch (e) {
      /* ignore */
    }
    this._panoViewer = null;
  }

  if (this._panoBlobUrl) {
    try {
      URL.revokeObjectURL(this._panoBlobUrl);
    } catch (e) {
      /* ignore */
    }
    this._panoBlobUrl = null;
  }

  var container = document.getElementById("sqPano");

  if (container) {
    container.innerHTML = "";
  }
};

// Decode an image blob and re-encode it downscaled to at most `maxW` px wide, so
// the panorama always fits this GPU's WebGL max texture size (a 7680px equirect
// fails to upload on many GPUs) and is a clean standard JPEG regardless of how the
// source was encoded. Returns a blob URL for the downscaled image.
SplatClickQuery.prototype._downscaleBlobToUrl = function (blob, maxW) {
  return new Promise(function (resolve, reject) {
    var srcUrl = URL.createObjectURL(blob);
    var img = new Image();

    img.onload = function () {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;

      if (!w || !h) {
        URL.revokeObjectURL(srcUrl);
        reject(new Error("bad image dimensions"));
        return;
      }

      var cap = maxW && maxW > 0 ? maxW : 4096;
      var scale = w > cap ? cap / w : 1;
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));

      var canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;

      try {
        canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      } catch (e) {
        URL.revokeObjectURL(srcUrl);
        reject(e);
        return;
      }

      URL.revokeObjectURL(srcUrl);

      canvas.toBlob(
        function (out) {
          if (out) {
            resolve(URL.createObjectURL(out));
          } else {
            reject(new Error("re-encode failed"));
          }
        },
        "image/jpeg",
        0.9,
      );
    };

    img.onerror = function () {
      URL.revokeObjectURL(srcUrl);
      reject(new Error("image decode failed"));
    };

    img.src = srcUrl;
  });
};

// Pannellum loads the panorama via XHR/fetch (for WebGL), not a plain <img> tag.
// ngrok's free tier returns an HTML interstitial on those requests unless the
// ngrok-skip-browser-warning header is present — direct browser navigation works
// without it, which is why thumbnails (base64) and pasted URLs look fine but the
// 360 viewer fails. Fetch with that header, then downscale in-browser so the
// result always uploads as a texture, and hand Pannellum the resulting blob URL.
SplatClickQuery.prototype._fetchPanoramaBlobUrl = function (url, maxW) {
  var self = this;
  return fetch(url, {
    mode: "cors",
    credentials: "omit",
    headers: {
      "ngrok-skip-browser-warning": "true",
    },
  }).then(function (response) {
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return response.blob();
  }).then(function (blob) {
    if (!blob || !blob.size) {
      throw new Error("empty image response");
    }
    return self._downscaleBlobToUrl(blob, maxW);
  });
};

// Open the full-resolution equirectangular panorama in an interactive 360 viewer,
// aimed at the clicked point (pano_yaw / pano_pitch) with a marker ring on it.
SplatClickQuery.prototype._openPano = function (imageData) {
  var self = this;
  var modal = document.getElementById("sqFullscreenModal");
  var base = String(this.apiBase || "").replace(/\/$/, "");
  var url = base + (imageData.image_url || "");

  // Cap the panorama width to something this GPU can definitely upload as a
  // texture. 4096 is safe on essentially every device; if the GPU reports a
  // smaller limit, use that.
  var maxTex = 4096;
  if (this.app && this.app.graphicsDevice && this.app.graphicsDevice.maxTextureSize) {
    maxTex = this.app.graphicsDevice.maxTextureSize;
  }
  var targetW = Math.min(maxTex, 4096);

  modal.classList.add("pano");
  this._destroyPano();

  var panoEl = document.getElementById("sqPano");
  if (panoEl) {
    panoEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#aaa;font-size:14px">Loading 360° panorama…</div>';
  }

  this._loadPannellum()
    .then(function (pannellum) {
      return self._fetchPanoramaBlobUrl(url, targetW).then(function (blobUrl) {
        return { pannellum: pannellum, blobUrl: blobUrl };
      });
    })
    .then(function (ctx) {
      // The user may have navigated away or closed while the library/image loaded.
      if (
        !ctx ||
        !ctx.pannellum ||
        !modal.classList.contains("pano") ||
        !modal.classList.contains("open")
      ) {
        if (ctx && ctx.blobUrl) {
          URL.revokeObjectURL(ctx.blobUrl);
        }
        return;
      }

      var yaw = Number(imageData.pano_yaw) || 0;
      var pitch = Number(imageData.pano_pitch) || 0;

      self._panoBlobUrl = ctx.blobUrl;

      if (panoEl) {
        panoEl.innerHTML = "";
      }

      self._panoViewer = ctx.pannellum.viewer("sqPano", {
        type: "equirectangular",
        panorama: ctx.blobUrl,
        autoLoad: true,
        showControls: true,
        yaw: yaw,
        pitch: pitch,
        hfov: 100,
        hotSpots: [
          {
            yaw: yaw,
            pitch: pitch,
            cssClass: "sq-pt-hotspot",
            createTooltipFunc: function (hs) {
              hs.classList.add("sq-pt-hotspot");
            },
          },
        ],
      });

      // Give the panorama keyboard focus so the arrow keys pan it right away
      // (Pannellum binds arrow-key panning to its focused container).
      if (panoEl && panoEl.focus) {
        try {
          panoEl.focus();
        } catch (e) {
          /* ignore */
        }
      }
    })
    .catch(function (err) {
      // If the viewer can't load, fall back to the flat equirectangular image.
      console.warn(
        "[SplatClickQuery] 360 viewer unavailable, showing flat image:",
        err && err.message ? err.message : err,
      );
      modal.classList.remove("pano");
      var image = document.getElementById("sqFullscreenImg");
      if (image && imageData.data_url) {
        image.src = imageData.data_url;
      }
    });
};

SplatClickQuery.prototype._showFullscreenByIndex = function (index) {
  if (!this._imageData || index < 0 || index >= this._imageData.length) {
    return false;
  }

  var imageData = this._imageData[index];

  if (!imageData || !imageData.data_url) {
    return false;
  }

  var modal = document.getElementById("sqFullscreenModal");
  var image = document.getElementById("sqFullscreenImg");
  var filename = imageData.filename || "image_" + (index + 1) + ".jpg";

  this._fullscreenIndex = index;
  modal.classList.add("open");

  // Freeze the underlying PlayCanvas camera (mouse orbit + WASD/arrow movement)
  // so interacting with the fullscreen/360 viewer never drives the scene behind it.
  this._setCameraToolLock(true);

  // Always tear down any previous panorama first.
  this._destroyPano();

  if (imageData.is_360 && imageData.image_url) {
    // 360 equirectangular photo → interactive panorama aimed at the clicked point.
    this._openPano(imageData);
  } else {
    // Regular (pinhole) photo → flat fullscreen image.
    modal.classList.remove("pano");
    image.src = imageData.data_url;
    image.alt = filename;
  }

  this._updateFullscreenNav();

  return true;
};

SplatClickQuery.prototype._navigateFullscreen = function (direction) {
  if (!this._isFullscreenOpen() || this._fullscreenIndex < 0) {
    return;
  }

  var nextIndex = this._findNavigableIndex(this._fullscreenIndex, direction);

  if (nextIndex === -1) {
    return;
  }

  this._showFullscreenByIndex(nextIndex);
};

SplatClickQuery.prototype._closeFullscreen = function () {
  var modal = document.getElementById("sqFullscreenModal");

  var image = document.getElementById("sqFullscreenImg");
  var counter = document.getElementById("sqFullscreenCounter");

  this._fullscreenIndex = -1;

  // Tear down the 360 viewer (if any) so it stops rendering in the background.
  this._destroyPano();

  // Restore camera input to whatever the tool state dictates (the update loop
  // re-locks it while click mode is active).
  this._setCameraToolLock(!!this._active);

  if (modal) {
    modal.classList.remove("open");
    modal.classList.remove("pano");
  }

  if (counter) {
    counter.textContent = "";
    counter.style.display = "none";
  }

  if (image) {
    // Clear after the closing animation starts.
    window.setTimeout(function () {
      var currentModal = document.getElementById("sqFullscreenModal");

      if (currentModal && !currentModal.classList.contains("open")) {
        image.removeAttribute("src");
      }
    }, 220);
  }
};

// ============================================================
// ERROR STATE
// ============================================================

SplatClickQuery.prototype._showError = function (message) {
  this._openPanel();

  this._updateFetchMoreUI(false, false);

  var selectAll = document.getElementById("sqSelectAll");

  var scroll = document.getElementById("sqScroll");

  var footer = document.getElementById("sqFooter");

  var state = document.getElementById("sqState");

  selectAll.style.display = "none";
  scroll.style.display = "none";
  footer.style.display = "none";

  state.style.display = "flex";
  state.innerHTML = "";

  var icon = document.createElement("div");

  icon.style.fontSize = "28px";
  icon.textContent = "⚠️";

  var errorText = document.createElement("div");

  errorText.style.color = "#f87171";
  errorText.style.fontSize = "12px";
  errorText.textContent = message || "An unknown error occurred.";

  var hint = document.createElement("div");

  hint.style.fontSize = "11px";
  hint.style.opacity = "0.5";

  hint.innerHTML =
    "Check the API/ngrok URL in<br>" + "the script attributes panel.";

  state.appendChild(icon);
  state.appendChild(errorText);
  state.appendChild(hint);

  console.error("[SplatClickQuery] Error:", message);
};

// ============================================================
// PDF BUTTON BUSY STATE
// ============================================================

SplatClickQuery.prototype._setPDFButtonBusy = function (busy, text) {
  var button = document.getElementById("sqExportPDF");

  if (!button) {
    return;
  }

  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.textContent = text || "Generating PDF...";

    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || "Export as PDF";

    button.disabled = false;

    delete button.dataset.originalText;
  }
};

// ============================================================
// RELIABLE PDF EXPORT
// ============================================================

SplatClickQuery.prototype._exportPDF = function () {
  var self = this;

  if (this._selectedIndices.length === 0) {
    alert("Please select at least one image first.");

    return;
  }

  var selectedImages = this._selectedIndices
    .slice()
    .sort(function (a, b) {
      return a - b;
    })
    .map(function (index) {
      var record = self._imageData[index];

      if (!record || !record.data_url) {
        return null;
      }

      return {
        index: index,

        source: record.data_url,

        filename: record.filename || "image_" + (index + 1) + ".jpg",
      };
    })
    .filter(function (item) {
      return item !== null;
    });

  if (selectedImages.length === 0) {
    alert("The selected records do not contain any image data.");

    return;
  }

  this._setPDFButtonBusy(true, "Generating PDF...");

  var preparedImages = [];

  this._loadPDFLibrary()
    .then(function (JsPDF) {
      return self._preparePDFImages(selectedImages).then(function (images) {
        preparedImages = images;

        return JsPDF;
      });
    })
    .then(function (JsPDF) {
      if (preparedImages.length === 0) {
        throw new Error("None of the selected images could be decoded.");
      }

      self._createPDFWithJsPDF(JsPDF, preparedImages);

      var skipped = selectedImages.length - preparedImages.length;

      if (skipped > 0) {
        alert(
          "PDF downloaded. " +
            skipped +
            " image(s) were skipped because they could not be decoded.",
        );
      } else {
        alert("PDF downloaded successfully.");
      }
    })
    .catch(function (error) {
      console.error("[SplatClickQuery] PDF generation error:", error);

      alert("PDF generation failed: " + error.message);
    })
    .then(
      function () {
        self._setPDFButtonBusy(false);
      },
      function (error) {
        console.error("[SplatClickQuery] Unexpected PDF error:", error);

        self._setPDFButtonBusy(false);
      },
    );
};

// ============================================================
// PREPARE ALL IMAGES FOR PDF
// ============================================================

SplatClickQuery.prototype._preparePDFImages = function (imageRecords) {
  var self = this;

  var jobs = imageRecords.map(function (record) {
    return self
      ._loadImageForPDF(record.source)
      .then(function (image) {
        return self._convertImageToPDFData(
          image,
          record.filename,
          record.index,
        );
      })
      .catch(function (error) {
        console.error(
          "[SplatClickQuery] Could not prepare image:",
          record.filename,
          error,
        );

        return null;
      });
  });

  return Promise.all(jobs).then(function (results) {
    return results.filter(function (item) {
      return item !== null;
    });
  });
};

// ============================================================
// LOAD AN IMAGE AND WAIT UNTIL DECODED
// ============================================================

SplatClickQuery.prototype._loadImageForPDF = function (source) {
  return new Promise(function (resolve, reject) {
    var image = new Image();
    var finished = false;

    var timeoutID = window.setTimeout(function () {
      fail(new Error("Image loading timed out."));
    }, 20000);

    function cleanup() {
      window.clearTimeout(timeoutID);

      image.onload = null;
      image.onerror = null;
    }

    function success() {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();

      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error("Image has invalid dimensions."));

        return;
      }

      resolve(image);
    }

    function fail(error) {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();

      reject(error || new Error("Image could not be loaded."));
    }

    image.onload = success;

    image.onerror = function () {
      fail(new Error("Image failed to load or decode."));
    };

    // Remote URLs need CORS permission for canvas export.
    // Data URLs and blob URLs do not.
    if (source.indexOf("data:") !== 0 && source.indexOf("blob:") !== 0) {
      image.crossOrigin = "anonymous";
    }

    image.src = source;

    // Cached data URLs can already be loaded.
    if (image.complete && image.naturalWidth > 0) {
      success();
    }
  });
};

// ============================================================
// CONVERT IMAGE TO SAFE JPEG DATA
// ============================================================

SplatClickQuery.prototype._convertImageToPDFData = function (
  image,
  filename,
  index,
) {
  var sourceWidth = image.naturalWidth || image.width;

  var sourceHeight = image.naturalHeight || image.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Image has no valid width or height.");
  }

  // Limit very large images to prevent browser crashes
  // while retaining enough resolution for A4 pages.
  var maximumDimension = 2400;

  var scale = Math.min(
    1,
    maximumDimension / Math.max(sourceWidth, sourceHeight),
  );

  var outputWidth = Math.max(1, Math.round(sourceWidth * scale));

  var outputHeight = Math.max(1, Math.round(sourceHeight * scale));

  var canvas = document.createElement("canvas");

  canvas.width = outputWidth;
  canvas.height = outputHeight;

  var context = canvas.getContext("2d", {
    alpha: false,
  });

  if (!context) {
    throw new Error("Could not create a canvas context.");
  }

  // JPEG does not support transparency.
  context.fillStyle = "#ffffff";

  context.fillRect(0, 0, outputWidth, outputHeight);

  context.imageSmoothingEnabled = true;

  if ("imageSmoothingQuality" in context) {
    context.imageSmoothingQuality = "high";
  }

  context.drawImage(image, 0, 0, outputWidth, outputHeight);

  // This throws if the canvas has been tainted by CORS.
  try {
    context.getImageData(0, 0, 1, 1);
  } catch (error) {
    throw new Error("The image is blocked by CORS and cannot be exported.");
  }

  var jpegDataURL = canvas.toDataURL("image/jpeg", 0.92);

  if (!jpegDataURL || jpegDataURL === "data:,") {
    throw new Error("The browser could not convert the image to JPEG.");
  }

  return {
    index: index,
    filename: filename,
    dataURL: jpegDataURL,
    width: outputWidth,
    height: outputHeight,
  };
};

// ============================================================
// CREATE VALID PDF USING JSPDF
// ============================================================

SplatClickQuery.prototype._createPDFWithJsPDF = function (JsPDF, images) {
  var firstImage = images[0];

  var firstOrientation =
    firstImage.width >= firstImage.height ? "landscape" : "portrait";

  var pdf = new JsPDF({
    orientation: firstOrientation,
    unit: "mm",
    format: "a4",
    compress: true,
    putOnlyUsedFonts: true,
  });

  var margin = 10;
  var filenameAreaHeight = 8;

  images.forEach(function (item, pageIndex) {
    var orientation = item.width >= item.height ? "landscape" : "portrait";

    if (pageIndex > 0) {
      pdf.addPage("a4", orientation);
    }

    var pageWidth = pdf.internal.pageSize.getWidth();

    var pageHeight = pdf.internal.pageSize.getHeight();

    var availableWidth = pageWidth - margin * 2;

    var availableHeight = pageHeight - margin * 2 - filenameAreaHeight;

    var imageRatio = item.width / item.height;

    var availableRatio = availableWidth / availableHeight;

    var drawWidth;
    var drawHeight;

    if (imageRatio > availableRatio) {
      drawWidth = availableWidth;
      drawHeight = drawWidth / imageRatio;
    } else {
      drawHeight = availableHeight;
      drawWidth = drawHeight * imageRatio;
    }

    var x = (pageWidth - drawWidth) / 2;

    var y = margin + filenameAreaHeight + (availableHeight - drawHeight) / 2;

    // Standard PDF fonts work best with ASCII text.
    var safeFilename = String(item.filename || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[^\x20-\x7E]/g, "?")
      .slice(0, 180);

    pdf.setFont("helvetica", "normal");

    pdf.setFontSize(9);

    pdf.setTextColor(70, 70, 70);

    if (safeFilename) {
      pdf.text(safeFilename, margin, margin + 4, {
        maxWidth: availableWidth,
      });
    }

    pdf.addImage(
      item.dataURL,
      "JPEG",
      x,
      y,
      drawWidth,
      drawHeight,
      undefined,
      "FAST",
    );
  });

  var filename = "splat_images_" + Date.now() + ".pdf";

  pdf.save(filename);
};

// ============================================================
// EXPORT INDIVIDUAL SELECTED IMAGES
// ============================================================

SplatClickQuery.prototype._exportSelected = function () {
  var self = this;

  var selectedIndices = this._selectedIndices.slice().sort(function (a, b) {
    return a - b;
  });

  if (selectedIndices.length === 0) {
    alert("Please select at least one image first.");

    return;
  }

  var exportedCount = 0;

  selectedIndices.forEach(function (index, order) {
    var imageRecord = self._imageData[index];

    if (!imageRecord || !imageRecord.data_url) {
      return;
    }

    window.setTimeout(function () {
      var anchor = document.createElement("a");

      anchor.href = imageRecord.data_url;

      anchor.download =
        imageRecord.filename || "splat_image_" + (index + 1) + ".jpg";

      anchor.style.display = "none";

      document.body.appendChild(anchor);

      anchor.click();

      document.body.removeChild(anchor);
    }, order * 180);

    exportedCount += 1;
  });

  if (exportedCount === 0) {
    alert("The selected records do not contain image data.");

    return;
  }
};

// ============================================================
// CLEANUP
// ============================================================

SplatClickQuery.prototype.destroy = function () {
  this.app.mouse.off(pc.EVENT_MOUSEDOWN, this._onMouseDown, this);
  this.app.mouse.off(pc.EVENT_MOUSEMOVE, this._onMouseMove, this);
  this.app.mouse.off(pc.EVENT_MOUSEUP, this._onMouseUp, this);

  if (this.app.touch) {
    this.app.touch.off(pc.EVENT_TOUCHSTART, this._onTouchStart, this);
  }

  if (this._escapeHandler) {
    document.removeEventListener("keydown", this._escapeHandler);

    this._escapeHandler = null;
  }

  if (this._markerToggleHandler) {
    document.removeEventListener("keydown", this._markerToggleHandler);

    this._markerToggleHandler = null;
  }

  if (this._calPanelToggleHandler) {
    document.removeEventListener("keydown", this._calPanelToggleHandler);

    this._calPanelToggleHandler = null;
  }

  if (this._markerToastTimeout) {
    window.clearTimeout(this._markerToastTimeout);

    this._markerToastTimeout = null;
  }

  var markerToast = document.getElementById("sqMarkerToast");

  if (markerToast && markerToast.parentNode) {
    markerToast.parentNode.removeChild(markerToast);
  }

  if (this._toolActivateHandler) {
    window.removeEventListener(
      "vroomk:activate-tool",
      this._toolActivateHandler,
    );

    this._toolActivateHandler = null;
  }

  if (this._onPickerResize) {
    this.app.graphicsDevice.off("resizecanvas", this._onPickerResize, this);

    this._onPickerResize = null;
  }

  this._picker = null;

  if (this._marker) {
    this._marker.destroy();

    this._marker = null;
  }

  this._removeExistingUI();

  this._imageData = [];
  this._selectedIndices = [];

  if (this._active) {
    this._setCameraToolLock(false);
  }

  this._removeExistingUI();
};
