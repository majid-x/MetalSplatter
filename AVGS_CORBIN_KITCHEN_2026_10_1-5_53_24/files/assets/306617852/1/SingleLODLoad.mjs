import { Script, Asset, Entity, Color } from 'playcanvas';

// ── WASM failure shim (suppresses unhandled rejections on mobile/Safari)
if (typeof window !== 'undefined' && !window.__fpsWasmGuardInstalled) {
    window.__fpsWasmGuardInstalled = true;
    const isWasmFailure = (reason) => {
        if (!reason) return false;
        let s = (typeof reason === 'string')
            ? reason
            : (reason.message || reason.stack || String(reason));
        if (!s) return false;
        s = s.toLowerCase();
        return s.indexOf('wasm') !== -1 ||
               s.indexOf('ammo') !== -1 ||
               s.indexOf('recast') !== -1 ||
               s.indexOf('esm.sh') !== -1 ||
               s.indexOf('emscripten') !== -1 ||
               s.indexOf('runtimeerror: abort') !== -1 ||
               s.indexOf('abort(') !== -1 ||
               s.indexOf('both async and sync fetching') !== -1 ||
               s.indexOf('failed to fetch dynamically imported module') !== -1 ||
               s.indexOf('failed to compile webassembly') !== -1;
    };
    window.addEventListener('unhandledrejection', (ev) => {
        if (isWasmFailure(ev && ev.reason)) {
            window.__fpsWasmFailed = true;
            console.warn('[SingleLodStreamer] suppressed wasm rejection: ' +
                ((ev.reason && ev.reason.message) || ev.reason));
            if (ev.preventDefault) ev.preventDefault();
        }
    });
    window.addEventListener('error', (ev) => {
        if (isWasmFailure(ev && (ev.error || ev.message))) {
            window.__fpsWasmFailed = true;
            if (ev.preventDefault) ev.preventDefault();
        }
    });
}

// ── Holographic Energy Pulse Reveal Shader (GLSL & WGSL)
const revealShaderGLSL = /* glsl */`
uniform float uRevealProgress;
uniform float uRevealMaxDist;
uniform float uWaveWidth;
uniform vec3 uWaveColor;
uniform float uWaveGlowIntensity;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    // When reveal finishes (progress >= 1.0), render 100% natural splats with zero overhead
    if (uRevealProgress >= 1.0) {
        return;
    }

    // Measure distance from camera view space on the GPU
    vec4 viewPos = matrix_view * (matrix_model * vec4(modifiedCenter, 1.0));
    float dist = length(viewPos.xyz);
    float currentRadius = uRevealProgress * uRevealMaxDist;

    // Ahead of the expanding pulse: completely hidden
    if (dist > currentRadius) {
        scale = vec3(0.0);
        return;
    }

    // Behind the pulse: smooth bloom inflation from 0.0 to 1.0
    float distBehind = currentRadius - dist;
    float factor = clamp(distBehind / max(uWaveWidth, 0.001), 0.0, 1.0);
    factor = smoothstep(0.0, 1.0, factor);
    scale *= factor;
}

void modifySplatColor(vec3 center, inout vec4 color) {
    if (uRevealProgress >= 1.0) {
        return;
    }

    vec4 viewPos = matrix_view * (matrix_model * vec4(center, 1.0));
    float dist = length(viewPos.xyz);
    float currentRadius = uRevealProgress * uRevealMaxDist;

    // Luminous glowing rim right at the wavefront edge!
    float edgeDist = abs(dist - currentRadius);
    if (edgeDist < uWaveWidth && dist <= currentRadius) {
        float glow = 1.0 - (edgeDist / uWaveWidth);
        glow = pow(glow, 2.0) * uWaveGlowIntensity;
        color.rgb += uWaveColor * glow;
    }
}
`;

const revealShaderWGSL = /* wgsl */`
fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let progress = uniform.uRevealProgress;
    if (progress >= 1.0) {
        return;
    }
    let dist = distance(modifiedCenter, uniforms.cameraPosition);
    let currentRadius = progress * uniform.uRevealMaxDist;
    if (dist > currentRadius) {
        *scale = vec3f(0.0);
        return;
    }
    let distBehind = currentRadius - dist;
    let factor = clamp(distBehind / max(uniform.uWaveWidth, 0.001), 0.0, 1.0);
    let smoothFactor = smoothstep(0.0, 1.0, factor);
    *scale *= smoothFactor;
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let progress = uniform.uRevealProgress;
    if (progress >= 1.0) {
        return;
    }
    let dist = distance(center, uniforms.cameraPosition);
    let currentRadius = progress * uniform.uRevealMaxDist;
    let edgeDist = abs(dist - currentRadius);
    if (edgeDist < uniform.uWaveWidth && dist <= currentRadius) {
        let glow = pow(1.0 - (edgeDist / uniform.uWaveWidth), 2.0) * uniform.uWaveGlowIntensity;
        (*color) = vec4f((*color).rgb + uniform.uWaveColor * glow, (*color).a);
    }
}
`;

/**
 * SingleLodStreamer
 * 
 * Loads ONE specific chosen LOD level across ALL distances for the entire scene,
 * completely ignoring other LODs to eliminate popping.
 * 
 * Features:
 * - Fixed LOD level across entire world (near, mid, far).
 * - Spherical Holographic Energy Wave Reveal Shader on scene entrance.
 * - Live re-triggering with triggerReveal() or pressing 'R'.
 * - Independent, constant environment/sky rendering.
 */
class SingleLodStreamer extends Script {
    static scriptName = 'singleLodStreamer';

    /**
     * URL of the main gsplat LOD octree dataset (e.g. lod-meta.json or .ply)
     * @attribute
     * @type {string}
     */
    splatUrl = '';

    /**
     * Optional URL of an environment / sky splat
     * @attribute
     * @type {string}
     */
    environmentUrl = '';

    /**
     * The specific LOD level to load across ALL distances (0 = finest/highest detail, 1 = mid, 2 = coarse, etc.)
     * Both minimum and maximum LOD are locked to this value, so no other levels are loaded.
     * @attribute
     * @type {number}
     */
    selectedLod = 0;

    /**
     * Keep environment splat constant at 100% scale (independent layer)
     * @attribute
     * @type {boolean}
     */
    keepEnvironmentConstant = true;

    /**
     * Show loading overlay while initial chunks are populated
     * @attribute
     * @type {boolean}
     */
    showLoadingOverlay = true;

    /**
     * Enable cool holographic radial energy wave reveal effect
     * @attribute
     * @type {boolean}
     */
    enableReveal = true;

    /**
     * Duration in seconds for the energy wave to sweep across the scene
     * @attribute
     * @type {number}
     */
    revealDuration = 3.0;

    /**
     * Maximum distance in meters the wave travels to reveal the full scene
     * @attribute
     * @type {number}
     */
    revealMaxDistance = 80.0;

    /**
     * Thickness in meters of the glowing wavefront rim
     * @attribute
     * @type {number}
     */
    waveWidth = 6.0;

    /**
     * Color of the glowing holographic wavefront (e.g. electric cyan, gold, neon purple)
     * @attribute
     * @type {Color}
     */
    waveColor = new Color(0.15, 0.75, 1.0);

    /**
     * Brightness multiplier for the glowing rim
     * @attribute
     * @type {number}
     */
    waveGlowIntensity = 1.8;

    /**
     * Automatically trigger reveal as soon as initial load finishes
     * @attribute
     * @type {boolean}
     */
    autoTriggerOnLoad = true;

    /** @type {Asset[]} */
    _assets = [];

    /** @type {Entity[]} */
    _children = [];

    /** @type {HTMLDivElement|null} */
    _loadingOverlay = null;

    /** @type {boolean} */
    _loadingComplete = false;

    /** @type {number} */
    _lastSelectedLod = -1;

    /** @type {boolean} */
    _revealShaderApplied = false;

    /** @type {boolean} */
    _isRevealing = false;

    /** @type {number} */
    _revealTimer = 0.0;

    initialize() {
        const app = this.app;

        // Global gsplat settings for single LOD loading
        app.scene.gsplat.radialSorting = true;
        app.scene.gsplat.lodBehindPenalty = 1;
        app.scene.gsplat.lodUnderfillLimit = 10;

        // Lock LOD range to the selected LOD across all distances
        const targetLod = Math.max(0, Math.floor(this.selectedLod));
        app.scene.gsplat.lodRangeMin = targetLod;
        app.scene.gsplat.lodRangeMax = targetLod;
        this._lastSelectedLod = targetLod;

        // Apply reveal shader if enabled
        if (this.enableReveal) {
            this._applyRevealShader();
            // Start at 0 progress (hidden) until reveal is triggered
            this._setShaderProgress(0.0);
        }

        // Loading overlay
        if (this.showLoadingOverlay) {
            this._createLoadingOverlay();
        }

        // Wait for gsplat system frame:ready event to hide loading screen
        if (app.systems && app.systems.gsplat && app.systems.gsplat.on) {
            app.systems.gsplat.on('frame:ready', this._onGsplatFrameReady, this);
        } else {
            this._hideLoadingOverlay();
        }

        // Safety timeout in case frame:ready doesn't fire
        this._loadingSafetyTimer = setTimeout(() => {
            if (!this._loadingComplete) {
                console.warn('[SingleLodStreamer] Safety timeout reached - hiding overlay.');
                this._hideLoadingOverlay();
            }
        }, 15000);

        // Load Main Splat (LOD octree)
        if (!this.splatUrl) {
            console.warn('[SingleLodStreamer] No splatUrl provided.');
        } else {
            const mainAsset = new Asset('MainGsplat_asset', 'gsplat', { url: this.splatUrl });
            app.assets.add(mainAsset);
            app.assets.load(mainAsset);
            this._assets.push(mainAsset);

            mainAsset.ready((a) => {
                const wasEnabled = this.entity.enabled;
                this.entity.enabled = false;

                this.entity.addComponent('gsplat', {
                    unified: true,
                    lodRangeMin: targetLod,
                    lodRangeMax: targetLod,
                    asset: a,
                });

                this.entity.enabled = wasEnabled;
                console.log(`[SingleLodStreamer] Main gsplat loaded with fixed LOD ${targetLod}.`);
            });
        }

        // Load Environment Splat (Optional background/sky)
        if (this.environmentUrl) {
            const envAsset = new Asset('EnvironmentGsplat_asset', 'gsplat', { url: this.environmentUrl });
            app.assets.add(envAsset);
            app.assets.load(envAsset);
            this._assets.push(envAsset);

            envAsset.ready((a) => {
                const child = new Entity('EnvironmentGsplat');
                child.enabled = false;

                this.entity.addChild(child);
                this._children.push(child);

                child.addComponent('gsplat', {
                    unified: !this.keepEnvironmentConstant,
                    lodRangeMin: targetLod,
                    lodRangeMax: targetLod,
                    asset: a,
                });

                child.enabled = true;
                console.log(`[SingleLodStreamer] Environment gsplat loaded (unified: ${!this.keepEnvironmentConstant}).`);
            });
        }

        // Bind keyboard 'R' to re-trigger reveal for testing
        this._onKeyDown = (e) => {
            if (e.key === 'r' || e.key === 'R') {
                this.triggerReveal();
            }
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this._onKeyDown);
        }
    }

    _applyRevealShader() {
        if (this._revealShaderApplied) return;
        const mat = this.app.scene?.gsplat?.material;
        if (!mat) return;

        const device = this.app.graphicsDevice;
        const isWebGPU = device?.isWebGPU;
        const chunks = mat.getShaderChunks(isWebGPU ? 'wgsl' : 'glsl');
        if (chunks) {
            chunks.set('gsplatModifyVS', isWebGPU ? revealShaderWGSL : revealShaderGLSL);
            mat.setParameter('uRevealProgress', 0.0);
            mat.setParameter('uRevealMaxDist', this.revealMaxDistance);
            mat.setParameter('uWaveWidth', this.waveWidth);
            mat.setParameter('uWaveColor', [this.waveColor.r, this.waveColor.g, this.waveColor.b]);
            mat.setParameter('uWaveGlowIntensity', this.waveGlowIntensity);
            mat.update();
            this._revealShaderApplied = true;
        }
    }

    _removeRevealShader() {
        if (!this._revealShaderApplied) return;
        const mat = this.app.scene?.gsplat?.material;
        if (mat) {
            const device = this.app.graphicsDevice;
            const isWebGPU = device?.isWebGPU;
            const chunks = mat.getShaderChunks(isWebGPU ? 'wgsl' : 'glsl');
            if (chunks) {
                chunks.delete('gsplatModifyVS');
                mat.update();
            }
        }
        this._revealShaderApplied = false;
    }

    _setShaderProgress(progress) {
        const mat = this.app.scene?.gsplat?.material;
        if (!mat) return;
        mat.setParameter('uRevealProgress', progress);
        mat.setParameter('uRevealMaxDist', this.revealMaxDistance);
        mat.setParameter('uWaveWidth', this.waveWidth);
        mat.setParameter('uWaveColor', [this.waveColor.r, this.waveColor.g, this.waveColor.b]);
        mat.setParameter('uWaveGlowIntensity', this.waveGlowIntensity);
        mat.update();
    }

    /**
     * Trigger the holographic wave reveal animation
     */
    triggerReveal() {
        if (!this.enableReveal) return;
        if (!this._revealShaderApplied) {
            this._applyRevealShader();
        }
        this._revealTimer = 0.0;
        this._isRevealing = true;
        this._setShaderProgress(0.0);
        console.log('[SingleLodStreamer] Triggered holographic wave reveal animation!');
    }

    _onGsplatFrameReady() {
        this._hideLoadingOverlay();
    }

    _hideLoadingOverlay() {
        if (this._loadingComplete) return;
        this._loadingComplete = true;

        if (this._loadingSafetyTimer) {
            clearTimeout(this._loadingSafetyTimer);
            this._loadingSafetyTimer = null;
        }

        if (this.app?.systems?.gsplat?.off) {
            this.app.systems.gsplat.off('frame:ready', this._onGsplatFrameReady, this);
        }

        const el = this._loadingOverlay;
        if (el) {
            el.style.opacity = '0';
            setTimeout(() => {
                if (el && el.parentNode) el.parentNode.removeChild(el);
                if (this._loadingOverlay === el) this._loadingOverlay = null;
            }, 600);
        }

        // Auto trigger reveal animation as soon as the loading screen fades!
        if (this.enableReveal && this.autoTriggerOnLoad) {
            setTimeout(() => {
                this.triggerReveal();
            }, 300);
        }
    }

    _createLoadingOverlay() {
        const existing = document.getElementById('single-lod-loading-overlay');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.id = 'single-lod-loading-overlay';
        Object.assign(el.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '9998',
            background: 'radial-gradient(ellipse at center, #1b2028 0%, #0c0e12 100%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            userSelect: 'none',
            pointerEvents: 'auto',
            transition: 'opacity 0.6s ease'
        });

        el.innerHTML = `
            <div style="font-size: 26px; font-weight: 700; letter-spacing: 0.05em; margin-bottom: 8px;">
                Loading Scene
            </div>
            <div style="font-size: 13px; color: #8fa0b5; margin-bottom: 24px;">
                Streaming fixed LOD ${Math.max(0, Math.floor(this.selectedLod))} across all distances...
            </div>
            <div style="
                width: 44px;
                height: 44px;
                border: 3px solid rgba(255, 255, 255, 0.15);
                border-top-color: #3b82f6;
                border-radius: 50%;
                animation: single-lod-spin 0.9s linear infinite;
            "></div>
            <style>
                @keyframes single-lod-spin {
                    to { transform: rotate(360deg); }
                }
            </style>
        `;

        document.body.appendChild(el);
        this._loadingOverlay = el;
    }

    _applyLod(lod) {
        const targetLod = Math.max(0, Math.floor(lod));
        const app = this.app;

        // Lock global scene range
        app.scene.gsplat.lodRangeMin = targetLod;
        app.scene.gsplat.lodRangeMax = targetLod;

        // Lock entity placement ranges
        if (this.entity.gsplat) {
            this.entity.gsplat.lodRangeMin = targetLod;
            this.entity.gsplat.lodRangeMax = targetLod;
        }

        for (let i = 0; i < this._children.length; i++) {
            const childGsplat = this._children[i]?.gsplat;
            if (childGsplat) {
                childGsplat.lodRangeMin = targetLod;
                childGsplat.lodRangeMax = targetLod;
            }
        }

        this._lastSelectedLod = targetLod;
        console.log(`[SingleLodStreamer] Switched to fixed LOD: ${targetLod} across all distances.`);
    }

    update(dt) {
        // Fire frame stats if UI is listening
        const rendered = this.app.stats?.frame?.gsplats || 0;
        this.app.fire('ui:updateStats', rendered);

        // Drive reveal animation timer
        if (this._isRevealing) {
            this._revealTimer += dt;
            const progress = Math.min(1.0, this._revealTimer / Math.max(0.1, this.revealDuration));
            this._setShaderProgress(progress);

            if (progress >= 1.0) {
                this._isRevealing = false;
                console.log('[SingleLodStreamer] Holographic reveal animation completed.');
            }
        }

        // React immediately if selectedLod is changed in the PlayCanvas inspector
        const currentLod = Math.max(0, Math.floor(this.selectedLod));
        if (this._lastSelectedLod !== currentLod) {
            this._applyLod(currentLod);
        }
    }

    onDestroy() {
        if (this._onKeyDown && typeof window !== 'undefined') {
            window.removeEventListener('keydown', this._onKeyDown);
            this._onKeyDown = null;
        }

        this._removeRevealShader();

        if (this._loadingSafetyTimer) {
            clearTimeout(this._loadingSafetyTimer);
            this._loadingSafetyTimer = null;
        }

        if (this.app?.systems?.gsplat?.off) {
            this.app.systems.gsplat.off('frame:ready', this._onGsplatFrameReady, this);
        }

        if (this._loadingOverlay && this._loadingOverlay.parentNode) {
            this._loadingOverlay.parentNode.removeChild(this._loadingOverlay);
        }
        this._loadingOverlay = null;

        // Unload and remove assets
        for (let i = 0; i < this._assets.length; i++) {
            const a = this._assets[i];
            if (a) {
                a.unload();
                this.app.assets.remove(a);
            }
        }
        this._assets.length = 0;

        // Remove gsplat component from entity
        if (this.entity.gsplat) {
            this.entity.removeComponent('gsplat');
        }

        // Destroy children
        for (let j = 0; j < this._children.length; j++) {
            const c = this._children[j];
            if (c && c.destroy) c.destroy();
        }
        this._children.length = 0;
    }
}

export { SingleLodStreamer };
