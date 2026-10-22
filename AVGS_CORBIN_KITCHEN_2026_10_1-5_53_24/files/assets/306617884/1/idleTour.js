var IdleTour = pc.createScript('idleTour');

// --- EXPOSED EDITOR UI VARIABLES ---
IdleTour.attributes.add('pathNodes', {
    type: 'entity',
    array: true,
    title: 'Path Nodes',
    description: 'Drag and drop the entities that form the tour loop.'
});

IdleTour.attributes.add('idleDelay', {
    type: 'number',
    default: 10,
    title: 'Inactivity Delay (Sec)',
    description: 'How many seconds of absolute silence before the tour starts.'
});

IdleTour.attributes.add('tourSpeed', {
    type: 'number',
    default: 0.1,
    title: 'Tour Speed Modifier',
    description: 'How fast the camera moves along the spline path.'
});

IdleTour.attributes.add('transitionSpeed', {
    type: 'number',
    default: 2.0,
    title: 'Transition Lerp Speed',
    description: 'How smoothly the camera blends onto the spline track when entering the tour.'
});

IdleTour.attributes.add('autoFocusWaypoints', {
    type: 'boolean',
    default: true,
    title: 'Auto Focus Waypoints',
    description: 'If checked, the camera dynamically looks at the closest scene waypoint while moving.'
});

// --- CORE LOGIC ---
IdleTour.prototype.initialize = function() {
    this.idleTimer = 0;
    this.state = 'INACTIVE'; // States: INACTIVE, BLENDING_IN, RUNNING
    
    this.currentSegment = 0;
    this.segmentProgress = 0; 

    this.transitionTimer = 0;
    this.entryPosition = new pc.Vec3();
    this.entryRotation = new pc.Quat();

    this.cameraManager = this.entity.script.cameraManager;

    var resetMovement = this.resetIdleTimer.bind(this);
    
    if (this.app.mouse) {
        this.app.mouse.on(pc.EVENT_MOUSEDOWN, resetMovement);
    }
    if (this.app.touch) {
        this.app.touch.on(pc.EVENT_TOUCHSTART, resetMovement);
    }
    if (this.app.keyboard) {
        this.app.keyboard.on(pc.EVENT_KEYDOWN, resetMovement);
    }
    
    // Cache waypoints for tracking performance optimization
    this.waypoints = [];
    this.refreshWaypoints();
};

IdleTour.prototype.refreshWaypoints = function() {
    this.waypoints = this.app.root.find(function(node) {
        return node.script && (node.script.waypoint || node.script.has('waypoint'));
    });
};

IdleTour.prototype.resetIdleTimer = function() {
    this.idleTimer = 0;
    if (this.state !== 'INACTIVE') {
        this.stopTour();
    }
};

IdleTour.prototype.startTour = function() {
    if (this.pathNodes.length < 4) {
        console.warn("IdleTour: You need at least 4 nodes to calculate a smooth spline loop!");
        return;
    }
    
    // Find the closest node on the track to seamlessly start from
    var currentPos = this.entity.getPosition();
    var closestIndex = 0;
    var shortestDistance = Infinity;

    for (var i = 0; i < this.pathNodes.length; i++) {
        var dist = currentPos.distance(this.pathNodes[i].getPosition());
        if (dist < shortestDistance) {
            shortestDistance = dist;
            closestIndex = i;
        }
    }

    this.currentSegment = closestIndex;
    this.segmentProgress = 0.0;
    this.state = 'BLENDING_IN';
    this.transitionTimer = 0;

    // Capture starting transforms for the entry blend
    this.entryPosition.copy(currentPos);
    this.entryRotation.copy(this.entity.getRotation());

    if (this.cameraManager) {
        this.cameraManager.enabled = false;
    }
    
    this.refreshWaypoints();
};

IdleTour.prototype.stopTour = function() {
    this.state = 'INACTIVE';

    if (this.cameraManager) {
        this.cameraManager.enabled = true;
        this.cameraManager.state = 'IDLE';
        this.cameraManager.syncAngles();
        this.cameraManager.homeBaseAngles.copy(this.cameraManager.eAngles);
    }
};

IdleTour.prototype.isMeasuringActive = function() {
    if (!this._splatMeasurer) {
        var entity = this.app.root.find(function(node) {
            return node.script && (node.script.splatMeasurer || node.script.has('splatMeasurer'));
        })[0];
        if (entity && entity.script && entity.script.splatMeasurer) {
            this._splatMeasurer = entity.script.splatMeasurer;
        }
    }
    return this._splatMeasurer && this._splatMeasurer.isMeasuringMode;
};

IdleTour.prototype.update = function(dt) {
    if (this.isMeasuringActive()) {
        this.idleTimer = 0;
        return;
    }

    if (this.state === 'INACTIVE') {
        if (this.cameraManager && this.cameraManager.state === 'IDLE') {
            this.idleTimer += dt;
            if (this.idleTimer >= this.idleDelay) {
                this.startTour();
            }
        }
    } else {
        this.updateTourCore(dt);
    }
};

IdleTour.prototype.updateTourCore = function(dt) {
    var numNodes = this.pathNodes.length;

    // Advance the spline progress timeline
    if (this.state === 'RUNNING') {
        this.segmentProgress += dt * this.tourSpeed;
        if (this.segmentProgress >= 1.0) {
            this.segmentProgress -= 1.0;
            this.currentSegment = (this.currentSegment + 1) % numNodes;
        }
    }

    // Solve control frames
    var p0_idx = (this.currentSegment - 1 + numNodes) % numNodes;
    var p1_idx = this.currentSegment;
    var p2_idx = (this.currentSegment + 1) % numNodes;
    var p3_idx = (this.currentSegment + 2) % numNodes;

    var p0 = this.pathNodes[p0_idx].getPosition();
    var p1 = this.pathNodes[p1_idx].getPosition();
    var p2 = this.pathNodes[p2_idx].getPosition();
    var p3 = this.pathNodes[p3_idx].getPosition();

    // target spline evaluation points
    var targetSplinePos = this.getCatmullRomPosition(this.segmentProgress, p0, p1, p2, p3);
    var targetSplineRot = new pc.Quat();

    // Determine target rotation (Auto-Focus Look vs Track Forward Look)
    var lookTarget = null;
    if (this.autoFocusWaypoints && this.waypoints.length > 0) {
        lookTarget = this.findNearestWaypointPosition(targetSplinePos);
    }

    var lookMatrix = new pc.Mat4();
    if (lookTarget) {
        lookMatrix.setLookAt(targetSplinePos, lookTarget, pc.Vec3.UP);
    } else {
        var lookAhead = this.getCatmullRomPosition(Math.min(this.segmentProgress + 0.05, 1.0), p0, p1, p2, p3);
        lookMatrix.setLookAt(targetSplinePos, lookAhead, pc.Vec3.UP);
    }
    targetSplineRot.setFromMat4(lookMatrix);

    // Run execution states
    if (this.state === 'BLENDING_IN') {
        this.transitionTimer += dt * this.transitionSpeed;
        var t = pc.math.clamp(this.transitionTimer, 0, 1);
        
        // Use smoothstep styling out for entry curving values
        var smoothT = t * t * (3 - 2 * t); 

        var blendedPos = new pc.Vec3().lerp(this.entryPosition, targetSplinePos, smoothT);
        var blendedRot = new pc.Quat().slerp(this.entryRotation, targetSplineRot, smoothT);

        this.entity.setPosition(blendedPos);
        this.entity.setRotation(blendedRot);

        if (t >= 1.0) {
            this.state = 'RUNNING';
        }
    } else {
        // Normal running mode
        this.entity.setPosition(targetSplinePos);
        
        // Keep rotational adjustments smooth during dynamic context targets swapping
        var finalRot = new pc.Quat().slerp(this.entity.getRotation(), targetSplineRot, 4 * dt);
        this.entity.setRotation(finalRot);
    }
};

IdleTour.prototype.findNearestWaypointPosition = function(currentCameraPos) {
    var nearestWp = null;
    var shortestDistance = Infinity;

    for (var i = 0; i < this.waypoints.length; i++) {
        var wp = this.waypoints[i];
        var dist = currentCameraPos.distance(wp.getPosition());
        if (dist < shortestDistance) {
            shortestDistance = dist;
            nearestWp = wp;
        }
    }
    return nearestWp ? nearestWp.getPosition() : null;
};

// --- CATMULL-ROM MATHEMATICAL EVALUATOR ---
IdleTour.prototype.getCatmullRomPosition = function(t, p0, p1, p2, p3) {
    var result = new pc.Vec3();
    var t2 = t * t;
    var t3 = t2 * t;

    result.x = 0.5 * ( (2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3 );
    result.y = 0.5 * ( (2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3 );
    result.z = 0.5 * ( (2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3 );

    return result;
};