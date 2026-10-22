var SplatMeasurer = pc.createScript("splatMeasurer");

// --- CAMERA & UTILITY ---
SplatMeasurer.attributes.add("cameraEntity", {
  type: "entity",
  title: "Camera Entity",
  description:
    "The primary camera used for world-space projection and depth calculation.",
});

SplatMeasurer.attributes.add("fontAsset", {
  type: "asset",
  assetType: "font",
  title: "UI Font Asset",
  description:
    "The runtime font asset used to generate the floating world-space text.",
});

// --- RENDER & PIPELINE LAYERS ---
SplatMeasurer.attributes.add("pickingLayerName", {
  type: "string",
  title: "Picking Layer Name",
  default: "World",
  description:
    "The layer where your Gaussian Splats or meshes exist. The tool will scan this layer for clicks.",
});

SplatMeasurer.attributes.add("renderingLayerName", {
  type: "string",
  title: "Placed Elements Layer Name",
  default: "World",
  description:
    "The layer where PERMANENT measurement pins, lasers, and text will be drawn.",
});

SplatMeasurer.attributes.add("previewLaserLayerName", {
  type: "string",
  title: "Preview Laser Layer Name",
  default: "World",
  description:
    "The layer where the real-time live preview laser line before clicking will be drawn.",
});

SplatMeasurer.attributes.add("reticleLayerName", {
  type: "string",
  title: "Hover Reticle Layer Name",
  default: "World",
  description:
    "The layer where the real-time tracking hover reticle primitive will be drawn.",
});

// --- CUSTOM MATERIALS & COLORS ---
SplatMeasurer.attributes.add("pinMaterial", {
  type: "asset",
  assetType: "material",
  title: "Pin Material",
});

SplatMeasurer.attributes.add("laserMaterial", {
  type: "asset",
  assetType: "material",
  title: "Placed Laser Material",
});

SplatMeasurer.attributes.add("previewLaserMaterial", {
  type: "asset",
  assetType: "material",
  title: "Live Preview Laser Material",
  description:
    "Dedicated material for the real-time preview line before clicking.",
});

SplatMeasurer.attributes.add("reticleMaterial", {
  type: "asset",
  assetType: "material",
  title: "Hover Reticle Material",
});

SplatMeasurer.attributes.add("textColor", {
  type: "rgb",
  title: "UI Text Color",
  default: [0, 1, 1],
});

// --- HOVER RETICLE GENERATION & OFFSETS ---
SplatMeasurer.attributes.add("reticleType", {
  type: "string",
  title: "Reticle Primitive Type",
  default: "cone",
  enum: [
    { Cone: "cone" },
    { Sphere: "sphere" },
    { Box: "box" },
    { Cylinder: "cylinder" },
    { Capsule: "capsule" },
    { Plane: "plane" },
    { "Custom Asset Mesh": "mesh" },
  ],
});

SplatMeasurer.attributes.add("reticleMeshAsset", {
  type: "asset",
  assetType: "render",
  title: "Custom Reticle Render Asset",
});

SplatMeasurer.attributes.add("reticlePosOffset", {
  type: "vec3",
  title: "Reticle Position Offset",
  default: [0, 0, 0],
});

SplatMeasurer.attributes.add("reticleRotOffset", {
  type: "vec3",
  title: "Reticle Rotation Offset",
  default: [180, 0, 0],
});

SplatMeasurer.attributes.add("reticleScaleOffset", {
  type: "vec3",
  title: "Reticle Base Scale",
  default: [0.06, 0.09, 0.06],
});

// --- SNAPPING MATRIX ENGINE ---
SplatMeasurer.attributes.add("enableSnapping", {
  type: "boolean",
  title: "Enable Point Snapping",
  default: true,
});

SplatMeasurer.attributes.add("snapRadius", {
  type: "number",
  title: "Snapping Radius Distance",
  default: 0.25,
});

// --- HARMONIC PULSE ANIMATION ---
SplatMeasurer.attributes.add("enablePulse", {
  type: "boolean",
  title: "Enable Reticle Pulse Anim",
  default: true,
});

SplatMeasurer.attributes.add("pulseSpeed", {
  type: "number",
  title: "Pulse Animation Speed",
  default: 3.5,
});

SplatMeasurer.attributes.add("pulseMinMultiplier", {
  type: "number",
  title: "Pulse Minimum Size Limit",
  default: 0.75,
});

SplatMeasurer.attributes.add("pulseMaxMultiplier", {
  type: "number",
  title: "Pulse Maximum Size Limit",
  default: 1.25,
});

// --- SYSTEM LIMITS & PERSISTENCE ---
SplatMeasurer.attributes.add("enableChaining", {
  type: "boolean",
  title: "Enable Chaining Mode",
  default: true,
});

SplatMeasurer.attributes.add("peripheralAngleLimit", {
  type: "number",
  title: "Peripheral Vision Angle",
  default: 60,
});

SplatMeasurer.attributes.add("pointLimit", {
  type: "number",
  title: "Max Point Limit",
  default: 10,
});

SplatMeasurer.attributes.add("persistInNormalMode", {
  type: "boolean",
  title: "Persist In Normal Mode",
  default: true,
});

// --- CONFIGURABLE DIMENSIONS ---
SplatMeasurer.attributes.add("customUnitLabel", {
  type: "string",
  title: "Custom Unit Suffix",
  default: "m",
});

SplatMeasurer.attributes.add("calibrationFactor", {
  type: "number",
  title: "Calibration Factor",
  default: 1.0,
  description:
    "Multiplier applied to raw distances. Input value is always in meters. When Imperial Formatting is enabled, the calibrated meter value is automatically converted to feet/inches.",
});

SplatMeasurer.attributes.add("pinSize", {
  type: "number",
  title: "Pin Sphere Scale",
  default: 0.05,
});

SplatMeasurer.attributes.add("laserThickness", {
  type: "number",
  title: "Laser Beam Thickness",
  default: 0.015,
});

SplatMeasurer.attributes.add("textSize", {
  type: "number",
  title: "World Text Scale",
  default: 0.003,
});

SplatMeasurer.attributes.add("textOffset", {
  type: "vec3",
  title: "Text Position Offset",
  default: [0, 0.08, 0],
  description:
    "Adjusts the directional spacing to push the text label up and away from the laser wires.",
});

SplatMeasurer.attributes.add("enableKeyboardShortcuts", {
  type: "boolean",
  default: true,
  title: "Enable Keyboard Hotkeys",
  description:
    "If unchecked, keyboard keys (G, Ctrl, Shift) will not control the measuring state.",
});

SplatMeasurer.attributes.add("enableImperialFormatting", {
  type: "boolean",
  default: false,
  title: "Enable Imperial Formatting",
  description:
    "If checked, measurements will be formatted to Feet, Inches, and fractions (American Tape Measure format).",
});

SplatMeasurer.attributes.add("useImperialSymbols", {
  type: "boolean",
  default: false,
  title: "Use Quotes (' \") Symbols",
  description:
    'If checked, uses \' for feet and \" for inches instead of "ft" and "in".',
});

SplatMeasurer.attributes.add("enableUndo", {
  type: "boolean",
  default: true,
  title: "Enable Undo",
  description: "Allows removing the last placed point via Ctrl+Z or UI button.",
});

SplatMeasurer.attributes.add("enableImperialFractions", {
  type: "boolean",
  default: true,
  title: "Enable Imperial Fractions",
  description:
    "If checked, imperial measurements will display fractions (e.g. 11/32). If unchecked, rounds to nearest inch.",
});

SplatMeasurer.attributes.add("useHoldMode", {
  type: "boolean",
  default: false,
  title: "Use Hold Mode (Snap/Delete)",
  description:
    "If checked, the Snapping Toggle and Delete Mode hotkeys require holding the key. Release reverts the state. If unchecked (default), they work as single-press toggles.",
});

// --- CUSTOMIZABLE HOTKEY BINDINGS ---
// See the hotkey documentation artifact for the full list of valid key names.
SplatMeasurer.attributes.add("hotkeyToggleMeasure", {
  type: "string",
  default: "KEY_G",
  title: "Hotkey: Toggle Measure",
  description: "Key name to toggle measuring mode on/off. Default: KEY_G",
});

SplatMeasurer.attributes.add("hotkeyEscape", {
  type: "string",
  default: "KEY_ESCAPE",
  title: "Hotkey: Exit/Escape",
  description:
    "Key name to exit/deactivate measuring mode. Default: KEY_ESCAPE",
});

SplatMeasurer.attributes.add("hotkeyNewChain", {
  type: "string",
  default: "KEY_SHIFT",
  title: "Hotkey: New Chain",
  description: "Key name to start a new measurement chain. Default: KEY_SHIFT",
});

SplatMeasurer.attributes.add("hotkeyUndo", {
  type: "string",
  default: "KEY_Z",
  title: "Hotkey: Undo",
  description: "Key name for undo (combined with Ctrl/Cmd). Default: KEY_Z",
});

SplatMeasurer.attributes.add("hotkeyDeleteMode", {
  type: "string",
  default: "KEY_ALT",
  title: "Hotkey: Delete Mode",
  description:
    "Key name to toggle or hold-activate deletion mode. Default: KEY_ALT",
});

SplatMeasurer.attributes.add("hotkeyToggleSnapping", {
  type: "string",
  default: "KEY_CONTROL",
  title: "Hotkey: Toggle Snapping",
  description:
    "Key name to toggle or hold-activate snapping. Default: KEY_CONTROL",
});

// --- CAMERA ORBIT DRAG IN MEASURE MODE ---
SplatMeasurer.attributes.add("orbitMouseButton", {
  type: "number",
  default: 1,
  title: "Orbit Drag Mouse Button",
  description:
    "Mouse button index for camera orbit drag while measuring. 0 = Left, 1 = Middle, 2 = Right. Default: 1 (Middle).",
});

SplatMeasurer.attributes.add("orbitDragSensitivity", {
  type: "number",
  default: 0.3,
  title: "Orbit Drag Sensitivity",
  description:
    "Mouse sensitivity for orbit dragging. Matches cameraManager orbitSensitivity by default.",
});

// --- INITIALIZATION ---
SplatMeasurer.prototype.initialize = function () {
  this.isMeasuringMode = false;

  this.nodes = [];

  this.hoverReticleContainer = null;
  this.hoverReticleMesh = null;
  this.previewLaserEntity = null;

  this.mouseX = 0;
  this.mouseY = 0;
  this.hoverUpdateTimer = 0;
  this.pulseAnimTimer = 0;

  this.isFirstPointOfSession = false;

  this.isDeleteMode = false;
  this.isDeleteModeFromUi = false;
  this.hoveredDeleteNodeIndex = -1;

  // Track hold-mode state for snapping/delete
  this._holdSnappingPrevState = this.enableSnapping;
  this._holdDeletePrevState = false;

  // Orbit drag state
  this._isOrbitDragging = false;
  this._lastDragX = 0;
  this._lastDragY = 0;
  this._cachedCameraManager = null;

  const device = this.app.graphicsDevice;
  this.clickPicker = new pc.Picker(this.app, device.width, device.height, true);
  this.previewPicker = new pc.Picker(
    this.app,
    device.width,
    device.height,
    true,
  );

  if (this.app.mouse) {
    this.app.mouse.on(pc.EVENT_MOUSEDOWN, this.onMouseDown, this);
    this.app.mouse.on(pc.EVENT_MOUSEMOVE, this.onMouseMove, this);
    this.app.mouse.on(pc.EVENT_MOUSEUP, this.onMouseUp, this);
  }
  if (this.app.keyboard) {
    this.app.keyboard.on(pc.EVENT_KEYDOWN, this.onKeyDown, this);
    this.app.keyboard.on(pc.EVENT_KEYUP, this.onKeyUp, this);
  }

  this.app.graphicsDevice.on("resizecanvas", this.onResize, this);

  this.buildHoverReticleSystem();
  this.buildPreviewLaserSystem();

  // Exit measuring when another tool (search images, search products, etc.) activates.
  var self = this;
  this._toolActivateHandler = function (event) {
    var tool = event && event.detail && event.detail.tool;
    if (tool && tool !== "measure" && self.isMeasuringMode) {
      self.exitMeasuringMode();
    }
  };
  window.addEventListener("vroomk:activate-tool", this._toolActivateHandler);
};

SplatMeasurer.prototype.enterMeasuringMode = function () {
  if (this.isMeasuringMode) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("vroomk:activate-tool", {
      detail: { tool: "measure" },
    }),
  );

  // Robust fallback: close other tool panels even if their listener didn't fire.
  var sqPanel = document.getElementById("sqPanel");
  if (sqPanel) {
    sqPanel.classList.remove("open");
  }
  var sqReopen = document.getElementById("sqReopenBtn");
  if (sqReopen) {
    sqReopen.style.display = "none";
  }
  var sstPanel = document.getElementById("sstPanel");
  if (sstPanel) {
    sstPanel.classList.remove("open");
  }
  var sstOverlay = document.getElementById("sst-overlay");
  if (sstOverlay) {
    sstOverlay.classList.remove("active");
  }
  var sstInstruct = document.getElementById("sst-instruct");
  if (sstInstruct) {
    sstInstruct.style.display = "none";
  }

  if (document.pointerLockElement) {
    document.exitPointerLock();
  }

  this.isMeasuringMode = true;
  this.setVisualsVisibility(true);
  this.hoverReticleContainer.enabled = true;
  this.isFirstPointOfSession = true;
};

SplatMeasurer.prototype.exitMeasuringMode = function () {
  if (!this.isMeasuringMode) {
    return;
  }

  this.isMeasuringMode = false;
  this._isOrbitDragging = false;
  this.hoverReticleContainer.enabled = false;
  this.previewLaserEntity.enabled = false;
  this.isDeleteModeFromUi = false;
  this.isDeleteMode = false;

  if (!this.persistInNormalMode) {
    this.setVisualsVisibility(false);
  }

  for (var i = 0; i < this.nodes.length; i++) {
    if (this.nodes[i].marker) {
      this.nodes[i].marker.setLocalScale(
        this.pinSize,
        this.pinSize,
        this.pinSize,
      );
    }
  }
};

SplatMeasurer.prototype.onResize = function (width, height) {
  this.clickPicker.resize(width, height);
  this.previewPicker.resize(width, height);
};

SplatMeasurer.prototype.getTargetLayerId = function (layerName) {
  var layer = this.app.scene.layers.getLayerByName(layerName);
  return layer ? layer.id : pc.LAYERID_WORLD;
};

// Mouse events report CSS/client pixels, but the pickers are sized to the
// backbuffer (device pixels). On HiDPI screens these differ by devicePixelRatio,
// which makes the picked point (and thus the reticle) drift from the cursor.
// Scale the cursor coordinates into the picker's resolution to keep them aligned.
SplatMeasurer.prototype.getPickerCoords = function (x, y) {
  var device = this.app.graphicsDevice;
  var canvas = device.canvas;
  var scaleX =
    canvas && canvas.clientWidth ? device.width / canvas.clientWidth : 1;
  var scaleY =
    canvas && canvas.clientHeight ? device.height / canvas.clientHeight : 1;
  return { x: x * scaleX, y: y * scaleY };
};

// PlayCanvas mouse events still fire when clicking DOM toolbar buttons.
SplatMeasurer.prototype._hitToolbarButton = function (x, y) {
  var buttonIds = ["sqTriggerBtn", "sst-btn", "sss-btn"];

  for (var i = 0; i < buttonIds.length; i++) {
    var button = document.getElementById(buttonIds[i]);
    if (!button) {
      continue;
    }

    var bounds = button.getBoundingClientRect();
    if (
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    ) {
      return true;
    }
  }

  return false;
};

SplatMeasurer.prototype.buildHoverReticleSystem = function () {
  this.hoverReticleContainer = new pc.Entity("ReticleAnchor");
  this.hoverReticleMesh = new pc.Entity("ReticleVisual");

  if (this.reticleType === "mesh" && this.reticleMeshAsset) {
    this.hoverReticleMesh.addComponent("render", {
      type: "asset",
      renderAsset: this.reticleMeshAsset,
    });
  } else {
    this.hoverReticleMesh.addComponent("render", {
      type: this.reticleType,
    });
  }

  if (this.reticleMaterial && this.reticleMaterial.resource) {
    this.reticleOriginalMaterial = this.reticleMaterial.resource;
    this.reticleDeleteMaterial = this.reticleMaterial.resource.clone();
    this.reticleDeleteMaterial.emissive = new pc.Color(1, 0, 0);
    this.reticleDeleteMaterial.diffuse = new pc.Color(1, 0, 0);
    this.reticleDeleteMaterial.update();
  } else {
    this.reticleOriginalMaterial = new pc.StandardMaterial();
    this.reticleOriginalMaterial.diffuse = new pc.Color(0, 1, 1);
    this.reticleOriginalMaterial.update();

    this.reticleDeleteMaterial = new pc.StandardMaterial();
    this.reticleDeleteMaterial.diffuse = new pc.Color(1, 0, 0);
    this.reticleDeleteMaterial.emissive = new pc.Color(1, 0, 0);
    this.reticleDeleteMaterial.update();
  }

  this.hoverReticleMesh.render.material = this.reticleOriginalMaterial;
  this.hoverReticleMesh.render.layers = [
    this.getTargetLayerId(this.reticleLayerName),
  ];

  this.hoverReticleMesh.setLocalPosition(this.reticlePosOffset);
  this.hoverReticleMesh.setLocalEulerAngles(this.reticleRotOffset);
  this.hoverReticleMesh.setLocalScale(this.reticleScaleOffset);

  this.hoverReticleContainer.addChild(this.hoverReticleMesh);
  this.hoverReticleContainer.enabled = false;
  this.app.root.addChild(this.hoverReticleContainer);
};

SplatMeasurer.prototype.buildPreviewLaserSystem = function () {
  this.previewLaserEntity = new pc.Entity("LivePreviewLaser");
  this.previewLaserEntity.addComponent("render", { type: "cylinder" });

  if (this.previewLaserMaterial) {
    this.previewLaserEntity.render.material =
      this.previewLaserMaterial.resource;
  } else if (this.laserMaterial) {
    this.previewLaserEntity.render.material = this.laserMaterial.resource;
  }

  this.previewLaserEntity.render.layers = [
    this.getTargetLayerId(this.previewLaserLayerName),
  ];

  this.previewLaserEntity.enabled = false;
  this.app.root.addChild(this.previewLaserEntity);
};

SplatMeasurer.prototype.onMouseMove = function (event) {
  this.mouseX = event.x;
  this.mouseY = event.y;

  if (this._isOrbitDragging && this.isMeasuringMode) {
    var dx = event.x - this._lastDragX;
    var dy = event.y - this._lastDragY;
    this._lastDragX = event.x;
    this._lastDragY = event.y;

    var camMgr = this.getCameraManager();
    if (camMgr && typeof camMgr.updateAngles === "function") {
      camMgr.updateAngles(dx, dy);
    } else {
      // Fallback: directly rotate the camera entity using euler angles
      var eulers = this.cameraEntity.getEulerAngles();
      eulers.y += dx * this.orbitDragSensitivity;
      eulers.x += dy * this.orbitDragSensitivity;
      eulers.x = pc.math.clamp(eulers.x, -90, 90);
      this.cameraEntity.setEulerAngles(eulers);
    }
  }
};

SplatMeasurer.prototype.onMouseUp = function (event) {
  if (event.button === this.orbitMouseButton) {
    this._isOrbitDragging = false;
  }
};

SplatMeasurer.prototype.getCameraManager = function () {
  if (this._cachedCameraManager) return this._cachedCameraManager;

  if (this.cameraEntity && this.cameraEntity.script) {
    this._cachedCameraManager = this.cameraEntity.script.cameraManager || null;
  }
  return this._cachedCameraManager;
};

SplatMeasurer.prototype.setVisualsVisibility = function (visible) {
  this.nodes.forEach((node) => {
    if (node.marker) node.marker.enabled = visible;
    if (node.laser) node.laser.enabled = visible;
    if (node.text) node.text.enabled = visible;
  });
};

SplatMeasurer.prototype.resolveKeyCode = function (keyName) {
  if (typeof keyName !== "string" || keyName.length === 0) return -1;
  var code = pc[keyName.toUpperCase()];
  return typeof code === "number" ? code : -1;
};

SplatMeasurer.prototype.onKeyDown = function (event) {
  if (!this.enableKeyboardShortcuts) return;

  var escapeCode = this.resolveKeyCode(this.hotkeyEscape);
  var deleteModeCode = this.resolveKeyCode(this.hotkeyDeleteMode);
  var toggleSnapCode = this.resolveKeyCode(this.hotkeyToggleSnapping);
  var undoCode = this.resolveKeyCode(this.hotkeyUndo);
  var newChainCode = this.resolveKeyCode(this.hotkeyNewChain);
  var toggleMeasureCode = this.resolveKeyCode(this.hotkeyToggleMeasure);

  if (event.key === escapeCode) {
    if (this.isMeasuringMode) {
      this.exitMeasuringMode();
    }
    return;
  }

  if (this.isMeasuringMode) {
    if (event.key === deleteModeCode) {
      if (event.event) {
        event.event.preventDefault();
        event.event.stopPropagation();
      }
      if (this.useHoldMode) {
        this._holdDeletePrevState = this.isDeleteModeFromUi;
        this.isDeleteModeFromUi = true;
        this.isDeleteMode = true;
      } else {
        this.isDeleteModeFromUi = !this.isDeleteModeFromUi;
        this.isDeleteMode = this.isDeleteModeFromUi;
      }
      return;
    }

    if (event.key === toggleSnapCode) {
      if (event.event) {
        event.event.preventDefault();
        event.event.stopPropagation();
      }
      if (this.useHoldMode) {
        this._holdSnappingPrevState = this.enableSnapping;
        this.enableSnapping = !this.enableSnapping;
      } else {
        this.enableSnapping = !this.enableSnapping;
      }
      return;
    }
  }

  if (
    this.enableUndo &&
    event.key === undoCode &&
    (event.event.ctrlKey || event.event.metaKey)
  ) {
    if (event.event) {
      event.event.preventDefault();
      event.event.stopPropagation();
    }
    this.undoLastPoint();
    return;
  }

  if (event.key === newChainCode) {
    this.isFirstPointOfSession = true;
    return;
  }

  if (event.key === toggleMeasureCode) {
    if (this.isMeasuringMode) {
      this.exitMeasuringMode();
    } else {
      this.enterMeasuringMode();
    }
  }
};

SplatMeasurer.prototype.onKeyUp = function (event) {
  if (
    !this.enableKeyboardShortcuts ||
    !this.useHoldMode ||
    !this.isMeasuringMode
  )
    return;

  var deleteModeCode = this.resolveKeyCode(this.hotkeyDeleteMode);
  var toggleSnapCode = this.resolveKeyCode(this.hotkeyToggleSnapping);

  if (event.key === deleteModeCode) {
    this.isDeleteModeFromUi = this._holdDeletePrevState;
    this.isDeleteMode = this.isDeleteModeFromUi;
  }

  if (event.key === toggleSnapCode) {
    this.enableSnapping = this._holdSnappingPrevState;
  }
};

SplatMeasurer.prototype.onMouseDown = async function (event) {
  // Handle orbit drag start for any measuring state
  if (this.isMeasuringMode && event.button === this.orbitMouseButton) {
    this._isOrbitDragging = true;
    this._lastDragX = event.x;
    this._lastDragY = event.y;
    if (event.event) {
      event.event.preventDefault();
    }
    return;
  }

  if (!this.isMeasuringMode || event.button !== pc.MOUSEBUTTON_LEFT) return;

  if (this.isOverUi) {
    this.isOverUi = false;
    return;
  }

  if (this._hitToolbarButton(event.x, event.y)) {
    return;
  }

  if (event.event) {
    event.event.preventDefault();
    event.event.stopPropagation();
  }

  this.isDeleteMode = this.isDeleteModeFromUi;

  if (this.isDeleteMode) {
    if (this.hoveredDeleteNodeIndex !== -1) {
      this.deletePoint(this.hoveredDeleteNodeIndex);
      this.hoveredDeleteNodeIndex = -1;

      // Delete mode is a single-shot action: after removing one point,
      // automatically toggle back to normal measuring mode.
      this.isDeleteModeFromUi = false;
      this.isDeleteMode = false;

      if (this.hoverReticleMesh && this.hoverReticleMesh.render) {
        this.hoverReticleMesh.render.material = this.reticleOriginalMaterial;
      }
    }
    return;
  }

  const targetPickLayer =
    this.app.scene.layers.getLayerByName(this.pickingLayerName) ||
    this.app.scene.layers.getLayerByName("World");

  var wasReticleEnabled = this.hoverReticleContainer.enabled;
  var wasPreviewEnabled = this.previewLaserEntity.enabled;
  this.hoverReticleContainer.enabled = false;
  this.previewLaserEntity.enabled = false;

  this.clickPicker.prepare(this.cameraEntity.camera, this.app.scene, [
    targetPickLayer,
  ]);

  this.hoverReticleContainer.enabled = wasReticleEnabled;
  this.previewLaserEntity.enabled = wasPreviewEnabled;

  try {
    const pickCoords = this.getPickerCoords(event.x, event.y);
    const hitPoint = await this.clickPicker.getWorldPointAsync(
      pickCoords.x,
      pickCoords.y,
    );

    if (!this.isMeasuringMode) {
      return;
    }

    if (hitPoint) {
      var finalTargetPosition = hitPoint.clone();

      if (this.enableSnapping && this.nodes.length > 0) {
        for (var i = 0; i < this.nodes.length; i++) {
          if (hitPoint.distance(this.nodes[i].position) < this.snapRadius) {
            finalTargetPosition.copy(this.nodes[i].position);
            break;
          }
        }
      }
      this.addPoint(finalTargetPosition);
    }
  } catch (e) {
    console.error("Click projection depth readback failed:", e);
  }
};

SplatMeasurer.prototype.addPoint = function (point) {
  if (this.nodes.length >= this.pointLimit) {
    this.removeOldestPoint();
  }

  var newPoint = point.clone();
  var markerEntity = this.createDebugMarker(newPoint);

  var nodeEntry = {
    position: newPoint,
    marker: markerEntity,
    laser: null,
    text: null,
    isStartOfChain: false,
  };

  var isStartOf = this.nodes.length === 0 || this.isFirstPointOfSession;
  nodeEntry.isStartOfChain = isStartOf;

  if (this.nodes.length > 0 && !isStartOf) {
    var shouldLink = false;
    var previousNode = this.nodes[this.nodes.length - 1];

    if (this.enableChaining) {
      var camPos = this.cameraEntity.getPosition();
      var camForward = this.cameraEntity.forward;
      var dirToPrev = new pc.Vec3()
        .sub2(previousNode.position, camPos)
        .normalize();
      var dot = camForward.dot(dirToPrev);
      var angleDegrees =
        Math.acos(pc.math.clamp(dot, -1, 1)) * pc.math.RAD_TO_DEG;

      if (angleDegrees <= this.peripheralAngleLimit) {
        shouldLink = true;
      }
    } else {
      if (this.nodes.length % 2 === 1) {
        shouldLink = true;
      }
    }

    if (shouldLink) {
      const rawDistance = previousNode.position.distance(newPoint);
      const calibratedDistance = rawDistance * this.calibrationFactor;
      const displayString = this.getFormattedDistance(calibratedDistance);

      nodeEntry.laser = this.create3DLaserBeam(previousNode.position, newPoint);
      nodeEntry.text = this.createWorldSpaceText(
        previousNode.position,
        newPoint,
        displayString,
      );
    } else {
      nodeEntry.isStartOfChain = true;
    }
  }

  this.nodes.push(nodeEntry);

  if (this.isFirstPointOfSession) {
    this.isFirstPointOfSession = false;
  }
};

SplatMeasurer.prototype.removeOldestPoint = function () {
  var oldestNode = this.nodes.shift();
  if (oldestNode) {
    if (oldestNode.marker) oldestNode.marker.destroy();
    if (oldestNode.laser) oldestNode.laser.destroy();
    if (oldestNode.text) oldestNode.text.destroy();
  }
  if (this.nodes.length > 0) {
    this.nodes[0].isStartOfChain = true;
    if (this.nodes[0].laser) {
      this.nodes[0].laser.destroy();
      this.nodes[0].laser = null;
    }
    if (this.nodes[0].text) {
      this.nodes[0].text.destroy();
      this.nodes[0].text = null;
    }
  }
};

SplatMeasurer.prototype.undoLastPoint = function () {
  if (!this.enableUndo) return;
  if (this.nodes.length === 0) return;

  var lastNode = this.nodes.pop();
  if (lastNode) {
    if (lastNode.marker) lastNode.marker.destroy();
    if (lastNode.laser) lastNode.laser.destroy();
    if (lastNode.text) lastNode.text.destroy();
  }

  if (this.nodes.length === 0) {
    this.isFirstPointOfSession = true;
  }
};

SplatMeasurer.prototype.deletePoint = function (index) {
  if (index < 0 || index >= this.nodes.length) return;

  var deletedNode = this.nodes[index];
  if (deletedNode.marker) deletedNode.marker.destroy();
  if (deletedNode.laser) deletedNode.laser.destroy();
  if (deletedNode.text) deletedNode.text.destroy();

  this.nodes.splice(index, 1);

  if (index < this.nodes.length) {
    this.nodes[index].isStartOfChain = true;
  }

  this.rebuildChainVisuals();
};

SplatMeasurer.prototype.rebuildChainVisuals = function () {
  for (var i = 0; i < this.nodes.length; i++) {
    if (this.nodes[i].laser) {
      this.nodes[i].laser.destroy();
      this.nodes[i].laser = null;
    }
    if (this.nodes[i].text) {
      this.nodes[i].text.destroy();
      this.nodes[i].text = null;
    }
  }

  if (this.nodes.length > 0) {
    this.nodes[0].isStartOfChain = true;
  }

  for (var i = 1; i < this.nodes.length; i++) {
    var node = this.nodes[i];
    if (node.isStartOfChain) {
      continue;
    }

    var previousNode = this.nodes[i - 1];
    const rawDistance = previousNode.position.distance(node.position);
    const calibratedDistance = rawDistance * this.calibrationFactor;
    const displayString = this.getFormattedDistance(calibratedDistance);

    node.laser = this.create3DLaserBeam(previousNode.position, node.position);
    node.text = this.createWorldSpaceText(
      previousNode.position,
      node.position,
      displayString,
    );
  }
};

SplatMeasurer.prototype.createDebugMarker = function (position) {
  const marker = new pc.Entity("SplatPin");
  marker.addComponent("render", { type: "sphere" });
  marker.setLocalScale(this.pinSize, this.pinSize, this.pinSize);
  marker.setPosition(position);

  if (this.pinMaterial) {
    marker.render.material = this.pinMaterial.resource;
  }

  marker.render.layers = [this.getTargetLayerId(this.renderingLayerName)];

  this.app.root.addChild(marker);
  return marker;
};

SplatMeasurer.prototype.create3DLaserBeam = function (p1, p2) {
  var laserSegment = new pc.Entity("LaserSegment");
  laserSegment.addComponent("render", { type: "cylinder" });

  if (this.laserMaterial) {
    laserSegment.render.material = this.laserMaterial.resource;
  }

  const midpoint = new pc.Vec3().add2(p1, p2).scale(0.5);
  const distance = p1.distance(p2);

  laserSegment.setPosition(midpoint);
  laserSegment.lookAt(p2);
  laserSegment.rotateLocal(90, 0, 0);
  laserSegment.setLocalScale(
    this.laserThickness,
    distance,
    this.laserThickness,
  );

  laserSegment.render.layers = [this.getTargetLayerId(this.renderingLayerName)];

  this.app.root.addChild(laserSegment);
  return laserSegment;
};

SplatMeasurer.prototype.createWorldSpaceText = function (p1, p2, textValue) {
  if (!this.fontAsset) return null;

  var textLabelEntity = new pc.Entity("SpatialLabelSegment");
  var engineColor = new pc.Color(
    this.textColor.r,
    this.textColor.g,
    this.textColor.b,
  );

  textLabelEntity.addComponent("element", {
    type: "text",
    text: textValue,
    fontAsset: this.fontAsset,
    fontSize: 32,
    color: engineColor,
    alignment: new pc.Vec2(0.5, 0.5),
    pivot: new pc.Vec2(0.5, 0.0), // Shifted local pivot to bottom edge
  });

  // Calculate center segment coordinate
  const midpoint = new pc.Vec3().add2(p1, p2).scale(0.5);

  // Inject custom Inspector offsets over the base coordinates
  midpoint.add(this.textOffset);

  textLabelEntity.setPosition(midpoint);
  textLabelEntity.setLocalScale(this.textSize, this.textSize, this.textSize);

  textLabelEntity.element.layers = [
    this.getTargetLayerId(this.renderingLayerName),
  ];

  this.app.root.addChild(textLabelEntity);
  return textLabelEntity;
};

SplatMeasurer.prototype.update = function (dt) {
  if (this.isMeasuringMode) {
    if (document.pointerLockElement) document.exitPointerLock();

    this.hoverUpdateTimer += dt;
    if (this.hoverUpdateTimer >= 0.02) {
      this.hoverUpdateTimer = 0;
      this.updateTrackingPreviews();
    }

    if (this.enablePulse && this.hoverReticleMesh) {
      this.pulseAnimTimer += dt;

      var sinWave = Math.sin(this.pulseAnimTimer * this.pulseSpeed);
      var normalizedSin = (sinWave + 1) * 0.5;
      var currentPulseScalar = pc.math.lerp(
        this.pulseMinMultiplier,
        this.pulseMaxMultiplier,
        normalizedSin,
      );

      this.hoverReticleMesh.setLocalScale(
        this.reticleScaleOffset.x * currentPulseScalar,
        this.reticleScaleOffset.y * currentPulseScalar,
        this.reticleScaleOffset.z * currentPulseScalar,
      );
    }
  }

  if (this.cameraEntity && this.nodes.length > 0) {
    const camPos = this.cameraEntity.getPosition();
    this.nodes.forEach(function (node) {
      if (node.text && node.text.enabled) {
        node.text.lookAt(camPos);
        node.text.rotateLocal(0, 180, 0);
      }
    });
  }
};

SplatMeasurer.prototype.updateTrackingPreviews = function () {
  if (!this.isMeasuringMode) return;

  const targetPickLayer =
    this.app.scene.layers.getLayerByName(this.pickingLayerName) ||
    this.app.scene.layers.getLayerByName("World");

  var wasReticleEnabled = this.hoverReticleContainer.enabled;
  var wasPreviewEnabled = this.previewLaserEntity.enabled;
  this.hoverReticleContainer.enabled = false;
  this.previewLaserEntity.enabled = false;

  this.previewPicker.prepare(this.cameraEntity.camera, this.app.scene, [
    targetPickLayer,
  ]);

  this.hoverReticleContainer.enabled = wasReticleEnabled;
  this.previewLaserEntity.enabled = wasPreviewEnabled;

  var self = this;
  var pickCoords = this.getPickerCoords(self.mouseX, self.mouseY);
  this.previewPicker
    .getWorldPointAsync(pickCoords.x, pickCoords.y)
    .then(function (currentSurfacePoint) {
      if (!currentSurfacePoint || !self.isMeasuringMode) {
        self.hoverReticleContainer.enabled = false;
        self.previewLaserEntity.enabled = false;
        return;
      }

      self.hoverReticleContainer.enabled = true;

      self.isDeleteMode = self.isDeleteModeFromUi;

      if (self.isDeleteMode) {
        var nearestNodeIdx = -1;
        var bestDist = self.snapRadius;

        for (var i = 0; i < self.nodes.length; i++) {
          var calculatedDistance = currentSurfacePoint.distance(
            self.nodes[i].position,
          );
          if (calculatedDistance < bestDist) {
            bestDist = calculatedDistance;
            nearestNodeIdx = i;
          }
        }

        // Reset all markers scale
        for (var i = 0; i < self.nodes.length; i++) {
          if (self.nodes[i].marker) {
            self.nodes[i].marker.setLocalScale(
              self.pinSize,
              self.pinSize,
              self.pinSize,
            );
          }
        }

        if (nearestNodeIdx !== -1) {
          currentSurfacePoint.copy(self.nodes[nearestNodeIdx].position);
          if (self.nodes[nearestNodeIdx].marker) {
            var highlightSize = self.pinSize * 1.5;
            self.nodes[nearestNodeIdx].marker.setLocalScale(
              highlightSize,
              highlightSize,
              highlightSize,
            );
          }
          self.hoveredDeleteNodeIndex = nearestNodeIdx;
        } else {
          self.hoveredDeleteNodeIndex = -1;
        }

        self.hoverReticleContainer.setPosition(currentSurfacePoint);

        if (self.hoverReticleMesh && self.hoverReticleMesh.render) {
          self.hoverReticleMesh.render.material = self.reticleDeleteMaterial;
        }
        self.previewLaserEntity.enabled = false;
      } else {
        // Reset all markers scale
        for (var i = 0; i < self.nodes.length; i++) {
          if (self.nodes[i].marker) {
            self.nodes[i].marker.setLocalScale(
              self.pinSize,
              self.pinSize,
              self.pinSize,
            );
          }
        }
        self.hoveredDeleteNodeIndex = -1;

        if (self.hoverReticleMesh && self.hoverReticleMesh.render) {
          self.hoverReticleMesh.render.material = self.reticleOriginalMaterial;
        }

        if (self.enableSnapping && self.nodes.length > 0) {
          var nearestPlacedPoint = null;
          var bestDistance = self.snapRadius;

          for (var i = 0; i < self.nodes.length; i++) {
            var calculatedDistance = currentSurfacePoint.distance(
              self.nodes[i].position,
            );
            if (calculatedDistance < bestDistance) {
              bestDistance = calculatedDistance;
              nearestPlacedPoint = self.nodes[i].position;
            }
          }

          if (nearestPlacedPoint) {
            currentSurfacePoint.copy(nearestPlacedPoint);
          }
        }

        self.hoverReticleContainer.setPosition(currentSurfacePoint);

        if (self.nodes.length > 0 && !self.isFirstPointOfSession) {
          var lastNode = self.nodes[self.nodes.length - 1];
          var showPreviewLine = false;

          if (self.enableChaining) {
            var camPos = self.cameraEntity.getPosition();
            var camForward = self.cameraEntity.forward;
            var dirToPrev = new pc.Vec3()
              .sub2(lastNode.position, camPos)
              .normalize();
            var dot = camForward.dot(dirToPrev);
            var angleDegrees =
              Math.acos(pc.math.clamp(dot, -1, 1)) * pc.math.RAD_TO_DEG;

            if (angleDegrees <= self.peripheralAngleLimit) {
              showPreviewLine = true;
            }
          } else {
            if (self.nodes.length % 2 === 1) {
              showPreviewLine = true;
            }
          }

          if (showPreviewLine) {
            const midpoint = new pc.Vec3()
              .add2(lastNode.position, currentSurfacePoint)
              .scale(0.5);
            const distance = lastNode.position.distance(currentSurfacePoint);

            self.previewLaserEntity.setPosition(midpoint);
            self.previewLaserEntity.lookAt(currentSurfacePoint);
            self.previewLaserEntity.rotateLocal(90, 0, 0);
            self.previewLaserEntity.setLocalScale(
              self.laserThickness,
              distance,
              self.laserThickness,
            );
            self.previewLaserEntity.enabled = true;
          } else {
            self.previewLaserEntity.enabled = false;
          }
        } else {
          self.previewLaserEntity.enabled = false;
        }
      }
    })
    .catch(function (err) {
      self.hoverReticleContainer.enabled = false;
      self.previewLaserEntity.enabled = false;
    });
};

SplatMeasurer.prototype.getFormattedDistance = function (meters) {
  if (this.enableImperialFormatting) {
    // 1 meter = 3.280839895 feet
    var totalFeet = meters * 3.280839895;
    var feet = Math.floor(totalFeet);
    var inches = 0;
    var fractionStr = "";

    if (this.enableImperialFractions) {
      var remainingInches = (totalFeet - feet) * 12;
      inches = Math.floor(remainingInches);
      var fractionOfInch = remainingInches - inches;

      // Round to nearest 32nd
      var numerator = Math.round(fractionOfInch * 32);

      // Handle overflow (rounding up to next inch/foot)
      if (numerator === 32) {
        numerator = 0;
        inches += 1;
      }
      if (inches === 12) {
        inches = 0;
        feet += 1;
      }

      // Simplify fraction
      if (numerator > 0) {
        var gcd = function (a, b) {
          return b ? gcd(b, a % b) : a;
        };
        var divisor = gcd(numerator, 32);
        fractionStr = " " + numerator / divisor + "/" + 32 / divisor;
      }
    } else {
      var totalInches = (totalFeet - feet) * 12;
      inches = Math.round(totalInches);
      if (inches === 12) {
        inches = 0;
        feet += 1;
      }
    }

    if (this.useImperialSymbols) {
      return feet + "' " + inches + fractionStr + '"';
    } else {
      return feet + " ft " + inches + fractionStr + " in";
    }
  } else {
    return `${meters.toFixed(3)} ${this.customUnitLabel}`;
  }
};

SplatMeasurer.prototype.destroy = function () {
  if (this._toolActivateHandler) {
    window.removeEventListener(
      "vroomk:activate-tool",
      this._toolActivateHandler,
    );
    this._toolActivateHandler = null;
  }

  this.exitMeasuringMode();
};
