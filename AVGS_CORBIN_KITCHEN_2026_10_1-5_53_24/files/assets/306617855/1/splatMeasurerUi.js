var SplatMeasurerUi = pc.createScript('splatMeasurerUi');

// --- EXPOSED EDITOR UI ATTRIBUTES ---
SplatMeasurerUi.attributes.add('toggleModeButton', {
    type: 'entity',
    title: 'Toggle Mode Button',
    description: 'The UI button to activate and deactivate measuring mode.'
});

SplatMeasurerUi.attributes.add('newChainButton', {
    type: 'entity',
    title: 'New Chain Button',
    description: 'The UI button to start a new measurement chain.'
});

SplatMeasurerUi.attributes.add('toggleSnappingButton', {
    type: 'entity',
    title: 'Toggle Snapping Button',
    description: 'The UI button to enable or disable point snapping.'
});

SplatMeasurerUi.attributes.add('deleteModeButton', {
    type: 'entity',
    title: 'Delete Mode Button',
    description: 'UI Button to toggle point deletion mode.'
});

SplatMeasurerUi.attributes.add('undoButton', {
    type: 'entity',
    title: 'Undo Button',
    description: 'UI Button to undo the last measurement.'
});

SplatMeasurerUi.attributes.add('springStiffness', {
    type: 'number',
    default: 160.0,
    title: 'Spring Stiffness',
    description: 'Stiffness of the pop-in spring animation. Higher values mean faster spring response.'
});

SplatMeasurerUi.attributes.add('springDamping', {
    type: 'number',
    default: 12.0,
    title: 'Spring Damping',
    description: 'Damping of the pop-in spring animation. Higher values reduce bounce/oscillation.'
});

SplatMeasurerUi.attributes.add('enableAnimations', {
    type: 'boolean',
    default: true,
    title: 'Enable Animations',
    description: 'If unchecked, the sub-menu buttons will appear and disappear instantly.'
});

SplatMeasurerUi.attributes.add('timeScale', {
    type: 'number',
    default: 1.0,
    title: 'Animation Time Scale',
    description: 'Multiplier for animation delta-time. Increase to make animations faster.'
});

SplatMeasurerUi.attributes.add('springMass', {
    type: 'number',
    default: 1.0,
    title: 'Spring Mass',
    description: 'The mass of the simulated spring. Higher values make the button pop heavier with more lag/inertia.'
});

// --- INITIALIZATION ---
SplatMeasurerUi.prototype.initialize = function() {
    this.measurer = this.entity.script.splatMeasurer;
    if (!this.measurer) {
        console.warn("SplatMeasurerUi: No SplatMeasurer script found on this entity. Looking on parent or scene...");
        var entity = this.app.root.find(function(node) {
            return node.script && (node.script.splatMeasurer || node.script.has('splatMeasurer'));
        })[0];
        if (entity && entity.script && entity.script.splatMeasurer) {
            this.measurer = entity.script.splatMeasurer;
        }
    }

    if (this.measurer) {
        this.measurer.isOverUi = false;
    }

    if (this.toggleModeButton && this.toggleModeButton.button) {
        this.toggleModeButton.button.on('click', this.toggleMeasuringMode, this);
    }
    if (this.newChainButton && this.newChainButton.button) {
        this.newChainButton.button.on('click', this.startNewChain, this);
    }
    if (this.toggleSnappingButton && this.toggleSnappingButton.button) {
        this.toggleSnappingButton.button.on('click', this.toggleSnapping, this);
    }
    if (this.deleteModeButton && this.deleteModeButton.button) {
        this.deleteModeButton.button.on('click', this.toggleDeleteMode, this);
    }
    if (this.undoButton && this.undoButton.button) {
        this.undoButton.button.on('click', this.undoLastPoint, this);
    }

    if (this.deleteModeButton && this.deleteModeButton.element) {
        this.deleteModeOriginalColor = this.deleteModeButton.element.color.clone();
    }
    if (this.toggleSnappingButton && this.toggleSnappingButton.element) {
        this.toggleSnappingOriginalColor = this.toggleSnappingButton.element.color.clone();
    }

    // Set up hover/click bounds flags to prevent world clicks while interacting with UI
    var self = this;
    var preventClickthrough = function(btnEntity) {
        if (btnEntity && btnEntity.element) {
            btnEntity.element.on('mousedown', function() {
                if (self.measurer) self.measurer.isOverUi = true;
            });
            btnEntity.element.on('mouseenter', function() {
                if (self.measurer) self.measurer.isOverUi = true;
            });
            btnEntity.element.on('mouseleave', function() {
                if (self.measurer) self.measurer.isOverUi = false;
            });
        }
    };
    preventClickthrough(this.toggleModeButton);
    preventClickthrough(this.newChainButton);
    preventClickthrough(this.toggleSnappingButton);
    preventClickthrough(this.deleteModeButton);
    preventClickthrough(this.undoButton);
};

// --- CORE UTILITY INTERACTIONS ---
SplatMeasurerUi.prototype.toggleMeasuringMode = function() {
    if (!this.measurer) return;

    this.measurer.isOverUi = false;

    if (this.measurer.isMeasuringMode) {
        this.measurer.exitMeasuringMode();
    } else {
        this.measurer.enterMeasuringMode();
    }
};

SplatMeasurerUi.prototype.startNewChain = function() {
    if (!this.measurer) return;
    this.measurer.isFirstPointOfSession = true;
    console.log("SplatMeasurerUi: Started new measurement chain.");
};

SplatMeasurerUi.prototype.toggleSnapping = function() {
    if (!this.measurer) return;
    this.measurer.enableSnapping = !this.measurer.enableSnapping;
    console.log("SplatMeasurerUi: Snapping set to " + this.measurer.enableSnapping);
};

SplatMeasurerUi.prototype.toggleDeleteMode = function() {
    if (!this.measurer) return;
    this.measurer.isDeleteModeFromUi = !this.measurer.isDeleteModeFromUi;
    console.log("SplatMeasurerUi: Delete mode set to " + this.measurer.isDeleteModeFromUi);
};

SplatMeasurerUi.prototype.undoLastPoint = function() {
    if (!this.measurer) return;
    this.measurer.undoLastPoint();
};

// --- FRAME LOOP (SPRING ANIMATION MECHANICS) ---
SplatMeasurerUi.prototype.update = function(dt) {
    if (!this.measurer) return;

    var isMeasuring = this.measurer.isMeasuringMode;

    // Apply spring physics scaling animation to sub-menu buttons
    this.updateSpringButton(this.newChainButton, isMeasuring, dt);
    this.updateSpringButton(this.toggleSnappingButton, isMeasuring, dt);
    this.updateSpringButton(this.deleteModeButton, isMeasuring, dt);
    this.updateSpringButton(this.undoButton, isMeasuring, dt);

    // Update delete mode button color indicator
    if (this.deleteModeButton && this.deleteModeButton.element && this.deleteModeOriginalColor) {
        if (this.measurer.isDeleteMode) {
            this.deleteModeButton.element.color = new pc.Color(1, 0, 0); // Solid red
        } else {
            this.deleteModeButton.element.color = this.deleteModeOriginalColor;
        }
    }

    // Update snapping button color indicator
    if (this.toggleSnappingButton && this.toggleSnappingButton.element && this.toggleSnappingOriginalColor) {
        if (this.measurer.enableSnapping) {
            this.toggleSnappingButton.element.color = new pc.Color(0, 0.8, 0.4); // Neon green/teal
        } else {
            this.toggleSnappingButton.element.color = this.toggleSnappingOriginalColor;
        }
    }
};

SplatMeasurerUi.prototype.updateSpringButton = function(buttonEntity, show, dt) {
    if (!buttonEntity) return;

    // Lazy cache of original target scale and animation weights on first call
    if (!buttonEntity._designScale) {
        buttonEntity._designScale = buttonEntity.getLocalScale().clone();
        buttonEntity._scaleFactor = show ? 1.0 : 0.0;
        buttonEntity._scaleVelocity = 0.0;
        if (!show) {
            buttonEntity.setLocalScale(0, 0, 0);
            buttonEntity.enabled = false;
        }
    }

    var targetFactor = show ? 1.0 : 0.0;

    // Turn on the entity before animating scale up
    if (show && !buttonEntity.enabled) {
        buttonEntity.enabled = true;
        buttonEntity._scaleFactor = 0.0;
        buttonEntity._scaleVelocity = 0.0;
        buttonEntity.setLocalScale(0, 0, 0);
    }

    if (!this.enableAnimations) {
        buttonEntity._scaleFactor = targetFactor;
        buttonEntity._scaleVelocity = 0.0;
        var scale = buttonEntity._designScale.clone().scale(targetFactor);
        buttonEntity.setLocalScale(scale);
        if (!show && buttonEntity.enabled) {
            buttonEntity.enabled = false;
        }
        return;
    }

    // Spring physics configuration
    var stiffness = this.springStiffness;
    var damping = this.springDamping;
    var mass = Math.max(0.01, this.springMass);
    var simDt = dt * this.timeScale;

    var displacement = targetFactor - buttonEntity._scaleFactor;
    var springForce = displacement * stiffness;
    var dampingForce = buttonEntity._scaleVelocity * damping;
    var acceleration = (springForce - dampingForce) / mass;

    buttonEntity._scaleVelocity += acceleration * simDt;
    buttonEntity._scaleFactor += buttonEntity._scaleVelocity * simDt;

    // Apply spring scale factor to cached design scale
    var scale = buttonEntity._designScale.clone().scale(buttonEntity._scaleFactor);
    buttonEntity.setLocalScale(scale);

    // Disable the entity once it shrinks back to zero to clear raycast blockages
    if (!show && buttonEntity.enabled && buttonEntity._scaleFactor <= 0.005 && Math.abs(buttonEntity._scaleVelocity) < 0.05) {
        buttonEntity.setLocalScale(0, 0, 0);
        buttonEntity.enabled = false;
        buttonEntity._scaleFactor = 0.0;
        buttonEntity._scaleVelocity = 0.0;
    }
};
