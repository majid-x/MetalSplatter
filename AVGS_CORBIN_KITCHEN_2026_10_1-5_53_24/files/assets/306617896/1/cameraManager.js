var CameraManager = pc.createScript('cameraManager');

// --- EXPOSED EDITOR UI VARIABLES ---
CameraManager.attributes.add('enableFPSMode', {
    type: 'boolean',
    default: false,
    title: 'Enable FPS Controller',
    description: 'If checked, the player can use the FPS hotkey to run around.',
    group: 'fpsSettings'
});

CameraManager.attributes.add('enableIdleWalking', {
    type: 'boolean',
    default: false,
    title: 'Enable Idle Walking',
    description: 'If checked, the user can walk in IDLE mode when FPS Mode is disabled.',
    group: 'fpsSettings'
});

CameraManager.attributes.add('enableOrbitMode', {
    type: 'boolean',
    default: true,
    title: 'Enable Orbit Mode',
    description: 'Toggle whether the user can click/touch and drag to orbit around active waypoints.',
    group: 'input'
});

CameraManager.attributes.add('enableHoverAnimation', {
    type: 'boolean',
    default: true,
    title: 'Enable Hover Animation',
    description: 'Toggle the idle floating/swaying animation when at a waypoint or at home base.',
    group: 'hoverAnimation'
});

CameraManager.attributes.add('lerpSpeed', { type: 'number', default: 4, title: 'Transition Speed', group: 'movement' });
CameraManager.attributes.add('orbitSensitivity', { type: 'number', default: 0.3, title: 'Orbit/Look Sensitivity', group: 'input' });

CameraManager.attributes.add('minPitch', { type: 'number', default: -85, title: 'Minimum Pitch (Look Up)', group: 'input' });
CameraManager.attributes.add('maxPitch', { type: 'number', default: 85, title: 'Maximum Pitch (Look Down)', group: 'input' });

CameraManager.attributes.add('safetyCushion', {
    type: 'number',
    default: 0.5,
    title: 'Collision Safety Cushion',
    description: 'How many meters to stop the camera BEFORE hitting a surface during orbit raycasts.',
    group: 'movement'
});

CameraManager.attributes.add('minCollisionRadius', {
    type: 'number',
    default: 1.5,
    title: 'Hard Core Safety Radius',
    description: 'The absolute minimum distance allowed from the waypoint center.',
    group: 'movement'
});

CameraManager.attributes.add('hoverAmplitude', { type: 'number', default: 1.5, title: 'Idle Pitch Swing (Degrees)', group: 'hoverAnimation' });
CameraManager.attributes.add('swayAmplitude', { type: 'number', default: 3.0, title: 'Idle Yaw Swing (Degrees)', group: 'hoverAnimation' });
CameraManager.attributes.add('hoverSpeed', { type: 'number', default: 1.5, title: 'Animation Speed', group: 'hoverAnimation' });

CameraManager.attributes.add('fpsToggleKey', {
    type: 'string',
    default: 'KEY_SPACE',
    title: 'FPS Activation Key',
    description: 'Key constant name from the PlayCanvas API (e.g., KEY_SPACE, KEY_F)',
    group: 'fpsSettings'
});

CameraManager.attributes.add('fpsMoveSpeed', {
    type: 'number',
    default: 5.0,
    title: 'FPS Movement Speed',
    group: 'fpsSettings'
});

CameraManager.attributes.add('fpsLookSensitivity', {
    type: 'number',
    default: 0.15,
    title: 'FPS Look Sensitivity',
    group: 'fpsSettings'
});

CameraManager.attributes.groups = {
    'movement': { title: 'Movement Settings' },
    'input': { title: 'Input Settings' },
    'hoverAnimation': { title: 'Hover Animation Settings' },
    'fpsSettings': { title: 'FPS Character Settings' }
};

// --- CORE LOGIC ---
CameraManager.prototype.initialize = function () {
    this.targetData = null;
    this.state = 'IDLE';

    this.timer = 0;
    this.animationWeight = 1.0;

    this.targetPosition = new pc.Vec3();
    this.targetRotation = new pc.Quat();

    this.blendPosition = new pc.Vec3();
    this.blendRotation = new pc.Quat();

    this.originalPosition = this.entity.getPosition().clone();
    this.originalRotation = this.entity.getRotation().clone();

    this.eAngles = new pc.Vec3();
    this.syncAngles = function () {
        var currentRot = this.entity.getRotation().getEulerAngles();
        this.eAngles.x = pc.math.clamp(currentRot.x, this.minPitch, this.maxPitch);
        this.eAngles.y = currentRot.y;
        this.eAngles.z = 0;
    };
    this.syncAngles();

    this.homeBaseAngles = this.eAngles.clone();

    this.lastFpsPosition = this.originalPosition.clone();
    this.lastFpsAngles = this.homeBaseAngles.clone();

    this.isDragging = false;
    this.dragType = null;
    this.blockInputFrame = false;
    this.toolInputLock = false;

    if (this.entity.rigidbody) this.entity.rigidbody.enabled = false;
    if (this.entity.collision) this.entity.collision.enabled = false;

    if (this.app.mouse) {
        this.app.mouse.on(pc.EVENT_MOUSEDOWN, this.onPointerDown, this);
        this.app.mouse.on(pc.EVENT_MOUSEMOVE, this.onPointerMove, this);
        this.app.mouse.on(pc.EVENT_MOUSEUP, this.onPointerUp, this);
    }

    if (this.app.touch) {
        this.app.touch.on(pc.EVENT_TOUCHSTART, this.onTouchStart, this);
        this.app.touch.on(pc.EVENT_TOUCHMOVE, this.onTouchMove, this);
        this.app.touch.on(pc.EVENT_TOUCHEND, this.onPointerUp, this);
        this.app.touch.on(pc.EVENT_TOUCHCANCEL, this.onPointerUp, this);
    }

    this.app.on('waypoint:select', this.handleWaypointSelection, this);

    this._onPointerLockChange = this.onPointerLockChange.bind(this);
    document.addEventListener('pointerlockchange', this._onPointerLockChange, false);
};

CameraManager.prototype.getSplatMeasurer = function () {
    if (!this._splatMeasurer) {
        var entity = this.app.root.find(function (node) {
            return node.script && (node.script.splatMeasurer || node.script.has('splatMeasurer'));
        })[0];
        if (entity && entity.script && entity.script.splatMeasurer) {
            this._splatMeasurer = entity.script.splatMeasurer;
        }
    }
    return this._splatMeasurer;
};

CameraManager.prototype.isMeasuringActive = function () {
    var measurer = this.getSplatMeasurer();
    return measurer && measurer.isMeasuringMode;
};

CameraManager.prototype.isSplatClickQueryActive = function () {
    // splatClickQuery is attached to multiple entities (e.g. disabled
    // "Gevork kitchen.sog" and active "LODSplat"). find()[0] can return the
    // wrong/inactive instance — scan all and return true if ANY is active.
    var entities = this.app.root.find(function (node) {
        return node.script && node.script.splatClickQuery;
    });
    for (var i = 0; i < entities.length; i++) {
        var sq = entities[i].script.splatClickQuery;
        if (sq && sq._active) {
            return true;
        }
    }
    return false;
};

CameraManager.prototype.isToolModeActive = function () {
    return this.toolInputLock || this.isMeasuringActive() || this.isSplatClickQueryActive();
};

CameraManager.prototype.setToolInputLock = function (locked) {
    this.toolInputLock = !!locked;
    if (locked) {
        this.suppressOrbitInput();
    }
};

CameraManager.prototype.suppressOrbitInput = function () {
    this.isDragging = false;
    this.dragType = null;
    if (this.state === 'FPS' || this.state === 'FPS_LERPING') {
        this.toggleFPSMode(false, false);
    }
    // Waypoint-hover orbit moves the camera position when eAngles change;
    // drop to IDLE so tool mode only allows look-rotate + WASD walk.
    if (this.state === 'HOVERING' || this.state === 'LERPING') {
        this.state = 'IDLE';
        this.blockInputFrame = false;
    }
};

CameraManager.prototype.handleWaypointSelection = function (data) {
    this.isDragging = false;
    this.dragType = null;
    this.blockInputFrame = true;

    if (this.state === 'FPS' || this.state === 'FPS_LERPING') {
        this.toggleFPSMode(false, false);
    }

    if (this.targetData && this.targetData.target === data.target && (this.state === 'HOVERING' || this.state === 'LERPING')) {
        this.revertToOriginal();
        return;
    }

    if (this.entity.rigidbody) this.entity.rigidbody.enabled = false;
    if (this.entity.collision) this.entity.collision.enabled = false;

    this.targetData = data;
    this.state = 'LERPING';
    this.timer = 0;
    this.animationWeight = 0.0;

    var waypointPos = data.target.getPosition();
    var waypointForward = data.target.forward.clone().normalize();
    var backward = waypointForward.scale(-1 * data.radius);

    var proposedPos = new pc.Vec3().copy(waypointPos).add(backward);

    proposedPos = this.enforceCollisionBoundaries(waypointPos, proposedPos);
    this.targetPosition.copy(proposedPos);

    var lookMatrix = new pc.Mat4();
    lookMatrix.setLookAt(this.targetPosition, waypointPos, pc.Vec3.UP);
    this.targetRotation.setFromMat4(lookMatrix);

    var offset = new pc.Vec3().sub2(waypointPos, this.targetPosition).normalize();

    this.eAngles.y = Math.atan2(-offset.x, -offset.z) * pc.math.RAD_TO_DEG;
    var pitchRad = Math.asin(offset.y);
    this.eAngles.x = pc.math.clamp(pitchRad * pc.math.RAD_TO_DEG, this.minPitch, this.maxPitch);
    this.eAngles.z = 0;
};

CameraManager.prototype.revertToOriginal = function () {
    this.targetData = null;
    this.state = 'REVERTING';

    if (this.entity.rigidbody) this.entity.rigidbody.enabled = false;
    if (this.entity.collision) this.entity.collision.enabled = false;

    this.targetPosition.copy(this.originalPosition);
    this.eAngles.copy(this.homeBaseAngles);

    this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
    this.timer = 0;
    this.animationWeight = 0.0;

    this.app.fire('camera:reverted');
};

CameraManager.prototype.toggleFPSMode = function (activate, autoFocusNearest) {
    if (!this.enableFPSMode) return;
    var canvas = this.app.graphicsDevice.canvas;

    if (activate) {
        var isAtWaypoint = (this.targetData || this.state === 'HOVERING' || this.state === 'LERPING');
        this.isDragging = false;
        this.dragType = null;

        if (isAtWaypoint) {
            this.state = 'FPS_LERPING';
            this.targetPosition.copy(this.lastFpsPosition);
            this.targetRotation.setFromEulerAngles(this.lastFpsAngles.x, this.lastFpsAngles.y, 0);
            this.eAngles.copy(this.lastFpsAngles);

            if (this.entity.rigidbody) this.entity.rigidbody.enabled = false;
            if (this.entity.collision) this.entity.collision.enabled = false;
        } else {
            this.state = 'FPS';
            this.syncAngles();

            if (this.entity.collision) this.entity.collision.enabled = true;
            if (this.entity.rigidbody) {
                this.entity.rigidbody.enabled = true;
                this.entity.rigidbody.type = pc.BODYTYPE_DYNAMIC;
                this.entity.rigidbody.angularFactor = pc.Vec3.ZERO;
                this.entity.rigidbody.teleport(this.entity.getPosition(), this.entity.getRotation());
                this.entity.rigidbody.linearVelocity = pc.Vec3.ZERO;
            }
        }

        if (canvas.requestPointerLock) {
            canvas.requestPointerLock();
        }
    } else {
        if (document.pointerLockElement === canvas && document.exitPointerLock) {
            document.exitPointerLock();
        }

        if (this.state === 'FPS' || this.state === 'FPS_LERPING') {
            this.lastFpsPosition.copy(this.entity.getPosition());
            this.lastFpsAngles.copy(this.eAngles);
        }

        this.state = 'IDLE';
        this.targetData = null;

        if (this.entity.rigidbody) {
            this.entity.rigidbody.linearVelocity = pc.Vec3.ZERO;
            this.entity.rigidbody.enabled = false;
        }
        if (this.entity.collision) {
            this.entity.collision.enabled = false;
        }

        // Focus nearest waypoint calculation or sync current look angles
        if (autoFocusNearest) {
            this.focusNearestWaypoint();
        } else {
            this.syncAngles();
        }
    }
};

CameraManager.prototype.focusNearestWaypoint = function () {
    var waypoints = this.app.root.find(function (node) {
        return node.script && (node.script.waypoint || node.script.has('waypoint'));
    });

    if (waypoints.length === 0) {
        this.syncAngles();
        return;
    }

    var currentPos = this.entity.getPosition();
    var nearestWaypoint = null;
    var shortestDistance = Infinity;

    for (var i = 0; i < waypoints.length; i++) {
        var waypointEntity = waypoints[i];
        var distance = currentPos.distance(waypointEntity.getPosition());
        if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestWaypoint = waypointEntity;
        }
    }

    // Fix: We manually redirect look angles toward the waypoint instead of activating it
    if (nearestWaypoint) {
        var waypointPos = nearestWaypoint.getPosition();
        var dir = new pc.Vec3().sub2(waypointPos, currentPos).normalize();

        // Convert the 3D direction vector directly to Pitch and Yaw degrees
        this.eAngles.y = Math.atan2(-dir.x, -dir.z) * pc.math.RAD_TO_DEG;

        var pitchRad = Math.asin(dir.y);
        this.eAngles.x = pc.math.clamp(pitchRad * pc.math.RAD_TO_DEG, this.minPitch, this.maxPitch);
        this.eAngles.z = 0;

        // Establish the target so the update() loop smoothly pans over to focus on it
        this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
    } else {
        this.syncAngles();
    }
};

CameraManager.prototype.onPointerLockChange = function () {
    var canvas = this.app.graphicsDevice.canvas;
    if (document.pointerLockElement !== canvas && (this.state === 'FPS' || this.state === 'FPS_LERPING')) {
        this.toggleFPSMode(false, true);
    }
};

CameraManager.prototype.onPointerDown = function (e) {
    if (this.isToolModeActive()) {
        this.suppressOrbitInput();
        return;
    }
    if (this.state === 'FPS' || this.state === 'FPS_LERPING') {
        var canvas = this.app.graphicsDevice.canvas;
        if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
            canvas.requestPointerLock();
        }
        return;
    }

    if (this.blockInputFrame) return;
    // Orbit drag is left-click only; middle/right are reserved for tools.
    if (e.button !== pc.MOUSEBUTTON_LEFT) return;
    this.isDragging = true;
    this.dragType = 'mouse';
    this.calculateWaypointOrbitPosition(this.eAngles.x, this.eAngles.y);
};

CameraManager.prototype.onTouchStart = function (e) {
    if (this.isToolModeActive()) {
        this.suppressOrbitInput();
        return;
    }
    if (this.blockInputFrame) return;

    if (e.touches.length === 1) {
        this.isDragging = true;
        this.dragType = 'touch';
        this.lastTouchX = e.touches[0].x;
        this.lastTouchY = e.touches[0].y;

        if (this.state !== 'FPS' && this.state !== 'FPS_LERPING') {
            this.calculateWaypointOrbitPosition(this.eAngles.x, this.eAngles.y);
        }
        if (e.event) e.event.preventDefault();
    }
};

CameraManager.prototype.onPointerMove = function (e) {
    if (this.isToolModeActive()) {
        this.suppressOrbitInput();
        return;
    }
    var canvas = this.app.graphicsDevice.canvas;

    if (this.state === 'FPS' || this.state === 'FPS_LERPING') {
        if (document.pointerLockElement === canvas) {
            var movementX = e.event ? (e.event.movementX || 0) : (e.dx || 0);
            var movementY = e.event ? (e.event.movementY || 0) : (e.dy || 0);

            this.eAngles.y -= movementX * this.fpsLookSensitivity;
            this.eAngles.x -= movementY * this.fpsLookSensitivity;
            this.eAngles.x = pc.math.clamp(this.eAngles.x, this.minPitch, this.maxPitch);

            if (this.state === 'FPS_LERPING') {
                this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
            }
        }
        return;
    }

    if (!this.isDragging || this.blockInputFrame || this.dragType !== 'mouse') return;
    this.updateAngles(e.dx || 0, e.dy || 0);
};

CameraManager.prototype.onTouchMove = function (e) {
    if (this.isToolModeActive()) {
        this.suppressOrbitInput();
        return;
    }
    if (this.blockInputFrame || !e.touches[0]) return;

    var touch = e.touches[0];
    var dx = touch.x - this.lastTouchX;
    var dy = touch.y - this.lastTouchY;

    this.lastTouchX = touch.x;
    this.lastTouchY = touch.y;

    if (this.state === 'FPS' || this.state === 'FPS_LERPING') {
        var movementX = e.event ? (e.event.movementX || dx) : dx;
        var movementY = e.event ? (e.event.movementY || dy) : dy;

        this.eAngles.y -= movementX * this.fpsLookSensitivity * 0.6;
        this.eAngles.x -= movementY * this.fpsLookSensitivity * 0.6;
        this.eAngles.x = pc.math.clamp(this.eAngles.x, this.minPitch, this.maxPitch);

        if (this.state === 'FPS_LERPING') {
            this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
        }
        if (e.event) e.event.preventDefault();
        return;
    }

    if (!this.isDragging || this.dragType !== 'touch') return;

    this.updateAngles(dx * 0.5, dy * 0.5);
    if (e.event) e.event.preventDefault();
};

CameraManager.prototype.onPointerUp = function () {
    this.isDragging = false;
    this.dragType = null;
    this.blockInputFrame = false;

    if (this.state === 'HOVERING' && this.enableOrbitMode) {
        this.targetPosition.copy(this.blendPosition);
        this.targetRotation.copy(this.blendRotation);
    } else if (this.state === 'IDLE') {
        this.homeBaseAngles.copy(this.eAngles);
    }
};

CameraManager.prototype.updateAngles = function (dx, dy) {
    this.eAngles.y += dx * this.orbitSensitivity;
    this.eAngles.x += dy * this.orbitSensitivity;
    this.eAngles.x = pc.math.clamp(this.eAngles.x, this.minPitch, this.maxPitch);

    // In tool mode, only rotate — never orbit the waypoint camera position.
    if (this.isToolModeActive()) {
        this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
        return;
    }

    this.calculateWaypointOrbitPosition(this.eAngles.x, this.eAngles.y);
};

CameraManager.prototype.calculateWaypointOrbitPosition = function (pitch, yaw) {
    var quat = new pc.Quat().setFromEulerAngles(pitch, yaw, 0);

    if (this.state === 'HOVERING' && this.targetData) {
        var backward = quat.transformVector(new pc.Vec3(0, 0, 1)).scale(this.targetData.radius);
        var waypointPos = this.targetData.target.getPosition();
        var proposedPos = new pc.Vec3().copy(waypointPos).add(backward);

        proposedPos = this.enforceCollisionBoundaries(waypointPos, proposedPos);
        this.blendPosition.copy(proposedPos);
        this.blendRotation.copy(quat);
    } else {
        this.blendRotation.copy(quat);
    }
};

CameraManager.prototype.enforceCollisionBoundaries = function (waypointPos, proposedPos) {
    var finalPos = new pc.Vec3().copy(proposedPos);

    if (this.app.systems.rigidbody) {
        var result = this.app.systems.rigidbody.raycastFirst(waypointPos, proposedPos);
        if (result) {
            var directionToWaypoint = new pc.Vec3().sub2(waypointPos, result.point).normalize();
            finalPos.copy(result.point).add(directionToWaypoint.scale(-this.safetyCushion));
        }
    }

    var centerDistance = finalPos.distance(waypointPos);
    if (centerDistance < this.minCollisionRadius) {
        var escapeDirection = new pc.Vec3().sub2(finalPos, waypointPos).normalize();
        finalPos.copy(waypointPos).add(escapeDirection.scale(this.minCollisionRadius));
    }

    return finalPos;
};

// --- RUNTIME FRAME UPDATE LOOP ---
CameraManager.prototype.update = function (dt) {
    if (this.isToolModeActive()) {
        this.suppressOrbitInput();
    }

    if (this.app.keyboard && this.enableFPSMode && !this.isToolModeActive()) {
        var mappedKey = pc[this.fpsToggleKey] || pc.KEY_SPACE;
        if (this.app.keyboard.wasPressed(mappedKey)) {
            var isActive = (this.state === 'FPS' || this.state === 'FPS_LERPING');
            this.toggleFPSMode(!isActive, true);
        }
    }

    if (this.isDragging && this.dragType === 'mouse' && this.app.mouse && !this.app.mouse.isPressed(pc.MOUSEBUTTON_LEFT)) {
        this.onPointerUp();
    }

    // --- STATE: FPS SMOOTH TRAVEL INTERCEPT ---
    if (this.state === 'FPS_LERPING') {
        var pos = this.entity.getPosition();
        var rot = this.entity.getRotation();

        var nextPos = new pc.Vec3().lerp(pos, this.targetPosition, this.lerpSpeed * dt);
        var nextRot = new pc.Quat().slerp(rot, this.targetRotation, this.lerpSpeed * dt);

        this.entity.setPosition(nextPos);
        this.entity.setRotation(nextRot);

        if (pos.distance(this.targetPosition) < 0.02) {
            this.state = 'FPS';
            this.targetData = null;

            if (this.entity.collision) this.entity.collision.enabled = true;
            if (this.entity.rigidbody) {
                this.entity.rigidbody.enabled = true;
                this.entity.rigidbody.type = pc.BODYTYPE_DYNAMIC;
                this.entity.rigidbody.angularFactor = pc.Vec3.ZERO;
                this.entity.rigidbody.teleport(this.targetPosition, this.targetRotation);
                this.entity.rigidbody.linearVelocity = pc.Vec3.ZERO;
            }
        }
        return;
    }

    // --- STATE: FPS CONTROLLER MODE ---
    if (this.state === 'FPS') {
        var moveX = 0;
        var moveZ = 0;

        if (this.app.keyboard.isPressed(pc.KEY_W) || this.app.keyboard.isPressed(pc.KEY_UP)) moveZ += 1;
        if (this.app.keyboard.isPressed(pc.KEY_S) || this.app.keyboard.isPressed(pc.KEY_DOWN)) moveZ -= 1;
        if (this.app.keyboard.isPressed(pc.KEY_A) || this.app.keyboard.isPressed(pc.KEY_LEFT)) moveX -= 1;
        if (this.app.keyboard.isPressed(pc.KEY_D) || this.app.keyboard.isPressed(pc.KEY_RIGHT)) moveX += 1;

        var isMoving = (moveX !== 0 || moveZ !== 0);

        var yawRad = this.eAngles.y * pc.math.DEG_TO_RAD;
        var fwdX = -Math.sin(yawRad);
        var fwdZ = -Math.cos(yawRad);
        var rgtX = Math.cos(yawRad);
        var rgtZ = -Math.sin(yawRad);

        var moveDirection = new pc.Vec3();
        if (isMoving) {
            moveDirection.set(fwdX * moveZ + rgtX * moveX, 0, fwdZ * moveZ + rgtZ * moveX);
            if (moveDirection.lengthSq() > 0) {
                moveDirection.normalize();
            }
        }

        if (this.entity.rigidbody && this.entity.rigidbody.enabled) {
            var currentVelocity = this.entity.rigidbody.linearVelocity;
            if (isMoving) {
                var velocityX = moveDirection.x * this.fpsMoveSpeed;
                var velocityZ = moveDirection.z * this.fpsMoveSpeed;
                this.entity.rigidbody.linearVelocity = new pc.Vec3(velocityX, currentVelocity.y, velocityZ);
            } else if (Math.abs(currentVelocity.x) > 0.01 || Math.abs(currentVelocity.z) > 0.01) {
                this.entity.rigidbody.linearVelocity = new pc.Vec3(0, currentVelocity.y, 0);
            }
        } else {
            this.entity.translate(moveDirection.scale(this.fpsMoveSpeed * dt));
        }

        this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);

        if (this.entity.rigidbody && this.entity.rigidbody.enabled) {
            var curRot = this.entity.getRotation();
            var angleDiff = Math.abs(curRot.x - this.targetRotation.x) +
                            Math.abs(curRot.y - this.targetRotation.y) +
                            Math.abs(curRot.z - this.targetRotation.z) +
                            Math.abs(curRot.w - this.targetRotation.w);
            if (angleDiff > 0.0001) {
                this.entity.rigidbody.teleport(this.entity.getPosition(), this.targetRotation);
            }
        } else {
            this.entity.setRotation(this.targetRotation);
        }
        return;
    }

    // --- STATE: IDLE (HOME / UNLOCKED REGULAR DRAG VIEW) ---
    if (this.state === 'IDLE') {
        var isIdleWalkingActive = (this.enableIdleWalking && !this.enableFPSMode);

        if (isIdleWalkingActive) {
            if (this.entity.collision && !this.entity.collision.enabled) {
                this.entity.collision.enabled = true;
            }
            if (this.entity.rigidbody) {
                if (!this.entity.rigidbody.enabled) {
                    this.entity.rigidbody.enabled = true;
                    this.entity.rigidbody.type = pc.BODYTYPE_DYNAMIC;
                    this.entity.rigidbody.angularFactor = pc.Vec3.ZERO;
                    this.entity.rigidbody.teleport(this.entity.getPosition(), this.entity.getRotation());
                    this.entity.rigidbody.linearVelocity = pc.Vec3.ZERO;
                }
            }
        } else {
            if (this.state !== 'FPS' && this.state !== 'FPS_LERPING') {
                if (this.entity.rigidbody && this.entity.rigidbody.enabled) {
                    this.entity.rigidbody.linearVelocity = pc.Vec3.ZERO;
                    this.entity.rigidbody.enabled = false;
                }
                if (this.entity.collision && this.entity.collision.enabled) {
                    this.entity.collision.enabled = false;
                }
            }
        }

        var moveX = 0;
        var moveZ = 0;
        if (isIdleWalkingActive && this.app.keyboard) {
            if (this.app.keyboard.isPressed(pc.KEY_W) || this.app.keyboard.isPressed(pc.KEY_UP)) moveZ += 1;
            if (this.app.keyboard.isPressed(pc.KEY_S) || this.app.keyboard.isPressed(pc.KEY_DOWN)) moveZ -= 1;
            if (this.app.keyboard.isPressed(pc.KEY_A) || this.app.keyboard.isPressed(pc.KEY_LEFT)) moveX -= 1;
            if (this.app.keyboard.isPressed(pc.KEY_D) || this.app.keyboard.isPressed(pc.KEY_RIGHT)) moveX += 1;
        }
        var isMoving = (moveX !== 0 || moveZ !== 0);

        var finalRotation = this.entity.getRotation();

        if (this.isDragging && !this.isToolModeActive()) {
            this.animationWeight = pc.math.lerp(this.animationWeight, 0.0, 15 * dt);
            this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
            finalRotation = new pc.Quat().slerp(this.entity.getRotation(), this.targetRotation, 15 * dt);
        } else if (this.isToolModeActive()) {
            this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
            finalRotation = new pc.Quat().slerp(this.entity.getRotation(), this.targetRotation, 15 * dt);
        } else if (isMoving) {
            // When walking, smoothly fade out idle sway so it doesn't fight locomotion
            this.animationWeight = pc.math.lerp(this.animationWeight, 0.0, 15 * dt);
            this.targetRotation.setFromEulerAngles(this.eAngles.x, this.eAngles.y, 0);
            finalRotation = new pc.Quat().slerp(this.entity.getRotation(), this.targetRotation, 15 * dt);
        } else {
            this.animationWeight = pc.math.lerp(this.animationWeight, 1.0, 4 * dt);

            var idlePitch = this.eAngles.x;
            var idleYaw = this.eAngles.y;

            if (this.enableHoverAnimation && this.animationWeight > 0.01) {
                this.timer += dt * this.hoverSpeed;

                var pitchOffset = Math.sin(this.timer) * this.hoverAmplitude * this.animationWeight;
                var yawOffset = Math.cos(this.timer * 0.5) * this.swayAmplitude * this.animationWeight;

                idlePitch = pc.math.clamp(this.eAngles.x + pitchOffset, this.minPitch, this.maxPitch);
                idleYaw = this.eAngles.y + yawOffset;
            }

            this.targetRotation.setFromEulerAngles(idlePitch, idleYaw, 0);
            finalRotation = new pc.Quat().slerp(this.entity.getRotation(), this.targetRotation, 8 * dt);
        }

        if (isIdleWalkingActive) {
            var yawRad = this.eAngles.y * pc.math.DEG_TO_RAD;
            var fwdX = -Math.sin(yawRad);
            var fwdZ = -Math.cos(yawRad);
            var rgtX = Math.cos(yawRad);
            var rgtZ = -Math.sin(yawRad);

            var moveDirection = new pc.Vec3();
            if (isMoving) {
                moveDirection.set(fwdX * moveZ + rgtX * moveX, 0, fwdZ * moveZ + rgtZ * moveX);
                if (moveDirection.lengthSq() > 0) {
                    moveDirection.normalize();
                }
            }

            if (this.entity.rigidbody && this.entity.rigidbody.enabled) {
                var currentVelocity = this.entity.rigidbody.linearVelocity;
                if (isMoving) {
                    var velocityX = moveDirection.x * this.fpsMoveSpeed;
                    var velocityZ = moveDirection.z * this.fpsMoveSpeed;
                    this.entity.rigidbody.linearVelocity = new pc.Vec3(velocityX, currentVelocity.y, velocityZ);
                } else if (Math.abs(currentVelocity.x) > 0.01 || Math.abs(currentVelocity.z) > 0.01) {
                    this.entity.rigidbody.linearVelocity = new pc.Vec3(0, currentVelocity.y, 0);
                }

                var curRot = this.entity.getRotation();
                var angleDiff = Math.abs(curRot.x - finalRotation.x) +
                                Math.abs(curRot.y - finalRotation.y) +
                                Math.abs(curRot.z - finalRotation.z) +
                                Math.abs(curRot.w - finalRotation.w);
                if (angleDiff > 0.0001) {
                    this.entity.rigidbody.teleport(this.entity.getPosition(), finalRotation);
                }
            } else {
                this.entity.translate(moveDirection.scale(this.fpsMoveSpeed * dt));
                this.entity.setRotation(finalRotation);
            }
        } else {
            this.entity.setRotation(finalRotation);
        }
        return;
    }

    // --- STATE: LERPING OR REVERTING (TRANSITIONAL TRAVEL FLIGHT) ---
    if (this.state === 'LERPING' || this.state === 'REVERTING') {
        var pos = this.entity.getPosition();
        var rot = this.entity.getRotation();

        var nextPos = new pc.Vec3().lerp(pos, this.targetPosition, this.lerpSpeed * dt);
        var nextRot = new pc.Quat().slerp(rot, this.targetRotation, this.lerpSpeed * dt);

        this.entity.setPosition(nextPos);
        this.entity.setRotation(nextRot);

        if (pos.distance(this.targetPosition) < 0.02) {
            if (this.state === 'LERPING') {
                this.state = 'HOVERING';
                this.blockInputFrame = false;
                this.blendPosition.copy(this.entity.getPosition());
                this.blendRotation.copy(this.entity.getRotation());
            } else {
                this.state = 'IDLE';
                this.blockInputFrame = false;
            }
        }
    }

    // --- STATE: HOVERING (LOCKED ON WAYPOINT STATE) ---
    if (this.state === 'HOVERING' && !this.isToolModeActive()) {
        if (this.isDragging && this.enableOrbitMode && !this.isToolModeActive()) {
            this.animationWeight = pc.math.lerp(this.animationWeight, 0.0, 15 * dt);

            var currentPos = this.entity.getPosition();
            var currentRot = this.entity.getRotation();

            var smoothDragPos = new pc.Vec3().lerp(currentPos, this.blendPosition, 15 * dt);
            var smoothDragRot = new pc.Quat().slerp(currentRot, this.blendRotation, 15 * dt);

            this.entity.setPosition(smoothDragPos);
            this.entity.setRotation(smoothDragRot);
        } else {
            this.animationWeight = pc.math.lerp(this.animationWeight, 1.0, 4 * dt);

            var animatedPitch = this.eAngles.x;
            var animatedYaw = this.eAngles.y;

            if (this.enableHoverAnimation && this.animationWeight > 0.01) {
                this.timer += dt * this.hoverSpeed;

                var pitchOffset = Math.sin(this.timer) * this.hoverAmplitude * this.animationWeight;
                var yawOffset = Math.cos(this.timer * 0.5) * this.swayAmplitude * this.animationWeight;

                animatedPitch = pc.math.clamp(this.eAngles.x + pitchOffset, this.minPitch, this.maxPitch);
                animatedYaw = this.eAngles.y + yawOffset;
            }

            this.calculateWaypointOrbitPosition(animatedPitch, animatedYaw);

            var smoothRecoveryPos = new pc.Vec3().lerp(this.entity.getPosition(), this.blendPosition, 8 * dt);
            var smoothRecoveryRot = new pc.Quat().slerp(this.entity.getRotation(), this.blendRotation, 8 * dt);

            this.entity.setPosition(smoothRecoveryPos);
            this.entity.setRotation(smoothRecoveryRot);
        }
    }
};

CameraManager.prototype.swap = function () {
    this.app.off('waypoint:select', this.handleWaypointSelection, this);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
};