var InitPlatformCheck = pc.createScript('initPlatformCheck');

// Create an attribute to select the entity you want to enable/disable
InitPlatformCheck.attributes.add('targetEntity', {
    type: 'entity',
    description: 'The entity to enable if touch is detected'
});

// initialize code called once per entity
InitPlatformCheck.prototype.initialize = function() {
    // Check if the device supports touch
    if (this.app.touch) {
        console.log("Touch device detected. Enabling entity.");
        
        if (this.targetEntity) {
            this.targetEntity.enabled = true;
        }
    } else {
        console.log("No touch device detected. Keeping entity disabled.");
        
        // Optional: Ensure it's disabled if not a touch device
        if (this.targetEntity) {
            this.targetEntity.enabled = false;
        }
    }
};