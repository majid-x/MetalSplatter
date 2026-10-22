var Waypoint = pc.createScript('waypoint');

// --- EXPOSED EDITOR UI VARIABLES ---
Waypoint.attributes.add('cameraEntity', {
    type: 'entity',
    title: 'Active Camera',
    description: 'The active camera entity this button should look at.'
});

Waypoint.attributes.add('uiElement', {
    type: 'entity',
    title: 'UI Button Entity',
    description: 'The 3D/World-Space button entity that the user clicks.'
});

Waypoint.attributes.add('radius', {
    type: 'number',
    default: 4,
    title: 'Camera Distance',
    description: 'How far back the camera stays from this point.'
});

// --- CORE LOGIC ---
Waypoint.prototype.initialize = function() {
    if (!this.cameraEntity) {
        this.cameraEntity = this.app.root.findByName('Camera');
        if (!this.cameraEntity) {
            console.warn("Waypoint '" + this.entity.name + "': No Active Camera assigned or found in scene.");
        }
    }
    
    if (this.uiElement && this.uiElement.button) {
        this.uiElement.button.on('click', this.onSelect, this);
    } else {
        console.warn("Waypoint '" + this.entity.name + "' needs a UI Entity with a Button component.");
    }
};

Waypoint.prototype.onSelect = function(event) {
    if (event) {
        if (event.stopPropagation) event.stopPropagation();
        if (event.event && event.event.stopPropagation) event.event.stopPropagation();
    }
    
    // Pass the waypoint's actual rotation along with the entity data
    this.app.fire('waypoint:select', {
        target: this.entity,
        radius: this.radius,
        rotation: this.entity.getRotation() // <-- Added: Sends the exact rotation set in editor
    });
};

Waypoint.prototype.postUpdate = function(dt) {
    if (this.uiElement && this.cameraEntity) {
        var camPos = this.cameraEntity.getPosition();
        this.uiElement.lookAt(camPos);
        this.uiElement.rotateLocal(0, 180, 0); 
    }
};