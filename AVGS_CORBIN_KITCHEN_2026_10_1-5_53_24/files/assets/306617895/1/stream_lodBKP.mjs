
import { Script, Asset, Entity, platform, Vec2 } from 'playcanvas';

// ── WASM failure shim (see character-controller.js for the full rationale).
// Duplicated here so the entry-point script installs the unhandled-rejection
// guard before Ammo / recast-navigation can fail on iOS WebView.
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
            console.warn('[fps] suppressed wasm-related unhandled rejection: ' +
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

class StreamedGsplat extends Script {
    static scriptName = 'streamedGsplat';

    /**
     * @attribute
     * @type {string}
     */
    splatUrl = '';

    /**
     * @attribute
     * @type {string}
     */
    environmentUrl = '';

    /**
     * @attribute
     * @type {number}
     */
    ultraLodBaseDistance = 5;

    /**
     * @attribute
     * @type {number}
     */
    ultraLodMultiplier = 1.8;

    /**
     * @attribute
     * @type {number}
     */
    highLodBaseDistance = 7;

    /**
     * @attribute
     * @type {number}
     */
    highLodMultiplier = 1.8;

    /**
     * @attribute
     * @type {number}
     */
    mediumLodBaseDistance = 6;

    /**
     * @attribute
     * @type {number}
     */
    mediumLodMultiplier = 2;

    /**
     * @attribute
     * @type {number}
     */
     lowLodBaseDistance = 4;

    /**
     * @attribute
     * @type {number}
     */
    lowLodMultiplier = 2.5;
    /**
     * @attribute
     * @type {Vec2}
     */
    ultraLodRange = new Vec2(0, 5);

    /**
     * @attribute
     * @type {Vec2}
     */
    highLodRange = new Vec2(1, 5);

    /**
     * @attribute
     * @type {Vec2}
     */
    mediumLodRange = new Vec2(2, 5);

    /**
     * @attribute
     * @type {Vec2}
     */
    lowLodRange = new Vec2(5, 5);
    /** @type {Asset[]} */
    _assets = [];

    /** @type {Entity[]} */
    _children = [];

    _highRes = false;

    _colorize = false;

    /** @type {HTMLDivElement|null} */
    _loadingOverlay = null;

    /** @type {HTMLDivElement|null} */
    _settingsOverlay = null;

    /** @type {boolean} */
    _loadingStarted = false;

    /** @type {boolean} */
    _loadingComplete = false;

    /** @type {number} */
    _maxLoadingCount = 0;

    /** @type {number} */
    _readyStableFrames = 0;

    /** @type {number} */
    _loadingStartTime = 0;

    /** @type {ReturnType<typeof setTimeout>|null} */
    _lodWidenTimer = null;

    initialize() {
        const app = this.app;

        // Default highlight on the settings screen - we don't commit to a
        // preset until the user clicks a button.
        this._currentPreset = platform.mobile ? 'low' : 'medium';

        this._createCameraPosOverlay();

        // global settings
        // lodBehindPenalty = 1 makes LOD selection purely distance-based:
        // nodes behind the camera are kept at the same LOD as nodes in front.
        // The upside is that rotating the camera in place can no longer
        // change any node's selected LOD, so it triggers zero new chunk
        // fetches (and therefore zero hitches felt as "jumping" mouse-look).
        // Cost is more VRAM since stuff behind you stays at full LOD.
        // lodUpdateAngle = 0 disables rotation-driven LOD recomputes; with
        // penalty = 1 the result wouldn't change anyway, so we save the CPU.
        app.scene.gsplat.radialSorting = true;
        app.scene.gsplat.lodBehindPenalty = 3;
        app.scene.gsplat.lodUnderfillLimit = 10;
        
        app.scene.gsplat.lodUpdateDistance = 4;
        app.scene.gsplat.lodUpdateAngle = 90;
        app.scene.gsplat.cooldownTicks = 1000;

        // Force only the coarsest LOD level during the initial load so the
        // overlay can stay up until the world is fully populated at low
        // quality (no holes / half-empty scene). Engine clamps these to
        // [0, maxLod] internally, so large values safely pin both ends to
        // the actual coarsest level that ships with the data.
        app.scene.gsplat.lodRangeMin = 999;
        app.scene.gsplat.lodRangeMax = 999;

        // Listen for UI events
        app.on('preset:ultra', () => this._setPreset('ultra'), this);
        app.on('preset:high', () => this._setPreset('high'), this);
        app.on('preset:medium', () => this._setPreset('medium'), this);
        app.on('preset:low', () => this._setPreset('low'), this);
        app.on('colorize:toggle', this._toggleColorize, this);

         // Apply initial resolution + post-effect state for the default preset.
        this._applyResolution();
        this._applySSAOForPreset();
        // Show the quality picker first - asset loading is deferred until
        // the user makes a choice.
        this._createSettingsOverlay();

        this.once('destroy', () => {
            this.onDestroy();
        });
    }

    _beginLoading() {
        if (this._loadingStarted) return;
        this._loadingStarted = true;

        const app = this.app;

        this._createLoadingOverlay();

        // Wait for gsplat LODs around the camera to finish loading before
        // revealing the scene. The gsplat component system fires 'frame:ready'
        // with (camera, layer, ready, loadingCount) every frame.
        this._loadingStartTime = performance.now();
        if (app.systems && app.systems.gsplat && app.systems.gsplat.on) {
            app.systems.gsplat.on('frame:ready', this._onGsplatFrameReady, this);
        } else {
            console.warn('[StreamedGsplat] gsplat system not available - hiding overlay immediately.');
            this._hideLoadingOverlay();
        }

        // Safety timeout so the overlay can never get stuck.
        this._loadingSafetyTimer = setTimeout(() => {
            if (!this._loadingComplete) {
                console.warn('[StreamedGsplat] loading safety timeout reached - hiding overlay.');
                this._hideLoadingOverlay();
            }
        }, 30000);

        // Load main splat - attach to entity directly
        if (!this.splatUrl) {
            console.warn('[StreamedGsplat] No splatUrl provided.');
        } else {
            const mainAsset = new Asset('MainGsplat_asset', 'gsplat', { url: this.splatUrl });
            app.assets.add(mainAsset);
            app.assets.load(mainAsset);
            this._assets.push(mainAsset);

            mainAsset.ready((a) => {
                // Temporarily disable entity to allow unified property to be set
                const wasEnabled = this.entity.enabled;
                this.entity.enabled = false;

                const lod = this._getCurrentLodParams();
                this.entity.addComponent('gsplat', {
                    unified: true,
                    lodBaseDistance: lod.baseDistance,
                    lodMultiplier: lod.multiplier,
                    asset: a,
                });

                this.entity.enabled = wasEnabled;

                // Do NOT apply the real preset yet - we want the initial load
                // restricted to the coarsest LOD only. The real preset range
                // is applied once loading of the coarsest level completes
                // (see _hideLoadingOverlay).
            });
        }

        // Load environment splat - attach to child entity
        if (!this.environmentUrl) {
            console.warn('[StreamedGsplat] No environmentUrl provided (skipping env child).');
        } else {
            const envAsset = new Asset('EnvironmentGsplat_asset', 'gsplat', { url: this.environmentUrl });
            app.assets.add(envAsset);
            app.assets.load(envAsset);
            this._assets.push(envAsset);

            envAsset.ready((a) => {
                const child = new Entity('EnvironmentGsplat');
                child.enabled = false;

                this.entity.addChild(child);
                this._children.push(child);

                const lod = this._getCurrentLodParams();
                child.addComponent('gsplat', {
                    unified: true,
                    lodBaseDistance: lod.baseDistance,
                    lodMultiplier: lod.multiplier,
                    asset: a,
                });

                child.enabled = true;
            });
        }
    }

    _getCurrentLodParams() {
        switch (this._currentPreset) {
            case 'ultra':
                return { baseDistance: this.ultraLodBaseDistance, multiplier: this.ultraLodMultiplier };
            case 'high':
                return { baseDistance: this.highLodBaseDistance, multiplier: this.highLodMultiplier };
            case 'medium':
                return { baseDistance: this.mediumLodBaseDistance, multiplier: this.mediumLodMultiplier };
            case 'low':
                return { baseDistance: this.lowLodBaseDistance, multiplier: this.lowLodMultiplier };
            default:
                return { baseDistance: 10, multiplier: 2 };
        }
    }

    _getCurrentLodRange() {
        let range;
        switch (this._currentPreset) {
            case 'ultra':
                range = this.ultraLodRange;
                break;
            case 'high':
                range = this.highLodRange;
                break;
            case 'medium':
                range = this.mediumLodRange;
                break;
            case 'low':
                range = this.lowLodRange;
                break;
            default:
                range = new Vec2(0, 5);
        }
        if (range) {
            if (typeof range.x === 'number' && typeof range.y === 'number') {
                return [range.x, range.y];
            }
            if (Array.isArray(range) && range.length >= 2) {
                return [Number(range[0]), Number(range[1])];
            }
        }
        return [0, 5];
    }

    _applyPreset() {
        const range = this._getCurrentLodRange();
        if (!range) return;

        const app = this.app;
        app.scene.gsplat.lodRangeMin = range[0];
        app.scene.gsplat.lodRangeMax = range[1];

        const lod = this._getCurrentLodParams();

        const applyToComponent = (gsplat) => {
            if (!gsplat) return;
            gsplat.lodBaseDistance = lod.baseDistance;
            gsplat.lodMultiplier = lod.multiplier;
        };

        applyToComponent(this.entity.gsplat);

        for (let i = 0; i < this._children.length; i++) {
            applyToComponent(this._children[i]?.gsplat);
        }
    }

    _setPreset(presetName) {
        this._currentPreset = presetName;

        // Resolution is cheap to flip immediately and doesn't affect the
        // coarsest-LOD load, so apply right away regardless of loading state.
        this._applyResolution();

        // Defer applying the LOD range while the initial coarsest-LOD load
        // is still in progress, otherwise we'd start pulling finer levels
        // and the overlay would stay up much longer. The preset is applied
        // for real in _hideLoadingOverlay once the coarsest load completes.
        if (this._loadingComplete) {
            this._applyPreset();
        }

        this.app.fire('ui:setPreset', presetName);
    }

    _applyResolution() {
        const device = this.app.graphicsDevice;
        const dpr = window.devicePixelRatio || 1;

        // Original (pre-optimisation) formula: half-resolution on retina,
        // native on non-retina. Used for medium / high / ultra so those
        // presets render exactly like before.
        const originalRatio = this._highRes ? Math.min(dpr, 2) : (dpr >= 2 ? dpr * 0.5 : dpr);

        // Only the low preset gets a tighter cap — clamps to 1.0 device pixel
        // per CSS pixel for ~4x fewer fragments on retina mobile.
        const target = this._currentPreset === 'low'
            ? Math.min(dpr, 1)
            : originalRatio;

        device.maxPixelRatio = target;
        this.app.resizeCanvas();
    }

    _applySSAOForPreset() {
        // SSAO is a fairly expensive screen-space post-effect (16+ taps +
        // bilateral blur). On mobile-friendly presets we disable it entirely;
        // medium/high/ultra keep it on for the visual quality.
        // const enabled = this._currentPreset !== 'low';
        // const visit = (e) => {
        //     if (e && e.script && e.script.ssao) {
        //         e.script.ssao.enabled = enabled;
        //     }
        //     if (e && e.children) {
        //         for (let i = 0; i < e.children.length; i++) {
        //             visit(e.children[i]);
        //         }
        //     }
        // };
        // if (this.app && this.app.root) visit(this.app.root);

        // Reduce per-frame gsplat LOD-recompute work on low. Bigger update
        // thresholds mean the engine only re-sorts / re-LODs splats when the
        // camera has actually moved/turned a meaningful amount, instead of
        // every single frame.
        // const gs = this.app && this.app.scene && this.app.scene.gsplat;
        // if (gs) {
        //     if (this._currentPreset === 'low') {
        //         gs.lodUpdateDistance = 4;
        //         gs.lodUpdateAngle = 180;
        //     } else {
        //         gs.lodUpdateDistance = 1;
        //         gs.lodUpdateAngle = 90;
        //     }
        // }
   }

    _toggleColorize() {
        this._colorize = !this._colorize;
        this.app.scene.gsplat.colorizeLod = this._colorize;
        
        const statusEl = document.getElementById('colorize-status');
        if (statusEl) {
            statusEl.textContent = this._colorize ? 'On' : 'Off';
        }
    }

    _createSettingsOverlay() {
        // Remove stale overlay from a prior hot-reload.
        const existing = document.getElementById('gsplat-settings-overlay');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        const el = document.createElement('div');
        el.id = 'gsplat-settings-overlay';
        Object.assign(el.style, {
            position: 'fixed',
            inset: '0',
            background: '#000',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontFamily: 'monospace',
            zIndex: '20001',
            pointerEvents: 'auto',
            padding: '40px 20px',
            boxSizing: 'border-box'
        });

        // Top: title + article link
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px'
        });

        const title = document.createElement('div');
        title.textContent = 'Gaussian Splatting FPS';
        title.style.cssText = 'font-size:28px;letter-spacing:2px;text-align:center;';
        header.appendChild(title);

        const articleLink = document.createElement('a');
        articleLink.href = 'https://blog.playcanvas.com/turning-a-gaussian-splat-into-a-videogame/';
        articleLink.target = '_blank';
        articleLink.rel = 'noopener noreferrer';
        articleLink.textContent = 'Read the article on the PlayCanvas blog';
        articleLink.style.cssText = 'font-size:12px;color:#4aa3ff;text-decoration:underline;opacity:0.85;';
        header.appendChild(articleLink);

        el.appendChild(header);

        // Center: graphics preset buttons
        const center = document.createElement('div');
        Object.assign(center.style, {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '14px'
        });

        const centerLabel = document.createElement('div');
        centerLabel.textContent = 'Graphics Settings';
        centerLabel.style.cssText = 'font-size:14px;letter-spacing:2px;opacity:0.7;margin-bottom:4px;';
        center.appendChild(centerLabel);

        const list = document.createElement('div');
        Object.assign(list.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            width: '260px'
        });

        const recommended = platform.mobile ? 'low' : 'medium';
        const presets = [
            { id: 'low',    label: 'Low',    hint: 'Fastest - mobile / low-end' },
            { id: 'medium', label: 'Medium', hint: 'Balanced' },
            { id: 'high',   label: 'High',   hint: 'Sharp - modern desktop' }
        ];

        presets.forEach((p) => {
            const btn = document.createElement('button');
            btn.type = 'button';

            const labelLine = document.createElement('div');
            labelLine.style.cssText = 'font-size:16px;letter-spacing:1px;';
            labelLine.textContent = p.label + (p.id === recommended ? '  (recommended)' : '');

            const hintLine = document.createElement('div');
            hintLine.style.cssText = 'font-size:11px;opacity:0.6;margin-top:3px;';
            hintLine.textContent = p.hint;

            btn.appendChild(labelLine);
            btn.appendChild(hintLine);

            Object.assign(btn.style, {
                padding: '12px 16px',
                background: p.id === recommended ? 'rgba(74,163,255,0.15)' : 'rgba(255,255,255,0.06)',
                color: '#fff',
                border: p.id === recommended ? '1px solid #4aa3ff' : '1px solid rgba(255,255,255,0.15)',
                borderRadius: '4px',
                fontFamily: 'monospace',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'background 0.15s, border-color 0.15s'
            });

            btn.addEventListener('mouseenter', () => {
                btn.style.background = 'rgba(74,163,255,0.25)';
                btn.style.borderColor = '#4aa3ff';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = p.id === recommended ? 'rgba(74,163,255,0.15)' : 'rgba(255,255,255,0.06)';
                btn.style.borderColor = p.id === recommended ? '#4aa3ff' : 'rgba(255,255,255,0.15)';
            });

            btn.addEventListener('click', () => this._onPresetSelected(p.id));

            list.appendChild(btn);
        });

        center.appendChild(list);

        const hint = document.createElement('div');
        hint.textContent = 'Click a quality to start the game';
        hint.style.cssText = 'font-size:11px;opacity:0.5;margin-top:6px;';
        center.appendChild(hint);

        el.appendChild(center);

        // Bottom spacer so the flex layout keeps the center block centered
        // between the header and the bottom edge.
        const spacer = document.createElement('div');
        spacer.style.cssText = 'width:1px;height:1px;';
        el.appendChild(spacer);

        // Prevent mousedown from bubbling to the window listener in input.js,
        // which would call requestPointerLock() and hide the cursor while this
        // overlay is still visible.
        el.addEventListener('mousedown', (e) => e.stopPropagation());

        document.body.appendChild(el);
        this._settingsOverlay = el;
    }

    _onPresetSelected(presetName) {
        this._currentPreset = presetName;

        // Notify any external UI so it can sync its own preset indicator.
        this.app.fire('ui:setPreset', presetName);

        this._removeSettingsOverlay();
        this._beginLoading();
    }

    _removeSettingsOverlay() {
        const el = this._settingsOverlay;
        if (!el) return;
        this._settingsOverlay = null;
        el.style.transition = 'opacity 0.3s ease-out';
        el.style.opacity = '0';
        setTimeout(() => {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        }, 320);
    }

    _createLoadingOverlay() {
        // Remove stale overlay from a prior hot-reload.
        const existing = document.getElementById('gsplat-loading-overlay');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        const el = document.createElement('div');
        el.id = 'gsplat-loading-overlay';
        Object.assign(el.style, {
            position: 'fixed',
            inset: '0',
            background: '#000',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '14px',
            fontFamily: 'monospace',
            fontSize: '18px',
            zIndex: '20000',
            transition: 'opacity 0.6s ease-out',
            opacity: '1',
            pointerEvents: 'auto'
        });

        const title = document.createElement('div');
        title.textContent = 'Loading environment…';
        title.style.cssText = 'font-size:20px;letter-spacing:1px;';
        el.appendChild(title);

        const barWrap = document.createElement('div');
        Object.assign(barWrap.style, {
            width: '260px',
            height: '6px',
            background: 'rgba(255,255,255,0.15)',
            borderRadius: '3px',
            overflow: 'hidden'
        });
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            width: '0%',
            height: '100%',
            background: '#4aa3ff',
            transition: 'width 0.2s linear'
        });
        barWrap.appendChild(bar);
        el.appendChild(barWrap);

        const pct = document.createElement('div');
        pct.textContent = '0%';
        pct.style.cssText = 'font-size:13px;opacity:0.8;';
        el.appendChild(pct);

        el.addEventListener('mousedown', (e) => e.stopPropagation());

        document.body.appendChild(el);

        this._loadingOverlay = el;
        this._loadingBar = bar;
        this._loadingPct = pct;
    }

    _onGsplatFrameReady(camera, layer, ready, loadingCount) {
        if (this._loadingComplete) return;

        // Track the peak loading count to turn it into a progress ratio.
        if (loadingCount > this._maxLoadingCount) {
            this._maxLoadingCount = loadingCount;
        }

        const peak = this._maxLoadingCount;
        const progress = peak > 0 ? (peak - loadingCount) / peak : 0;

        if (this._loadingBar) {
            this._loadingBar.style.width = Math.round(progress * 100) + '%';
        }
        if (this._loadingPct) {
            this._loadingPct.textContent = Math.round(progress * 100) + '% (' + loadingCount + ' pending)';
        }

        // Require: loader has actually started (peak > 0), everything is done,
        // sorting is up to date, and we've seen a few stable frames in a row
        // so we don't hide the overlay on a brief pre-stream zero.
        const elapsed = performance.now() - this._loadingStartTime;
        if (peak > 0 && ready && loadingCount === 0) {
            this._readyStableFrames++;
            if (this._readyStableFrames >= 3) {
                this._hideLoadingOverlay();
            }
        } else if (peak === 0 && elapsed > 4000) {
            // No loading activity at all for 4s — probably nothing to stream.
            this._hideLoadingOverlay();
        } else {
            this._readyStableFrames = 0;
        }
    }

    _hideLoadingOverlay() {
        if (this._loadingComplete) return;

        // Two-stage widen: clamp the LOD range one level coarser than the
        // user's chosen preset for the first ~2 seconds, then drop to the
        // real range. This avoids a single big burst of finest-LOD chunk
        // fetches at the exact moment the overlay disappears (which
        // coincides with the user starting to look around -> frame hitches
        // felt as "jumping" mouse-look).
        const range = this._getCurrentLodRange();
        const lod = this._getCurrentLodParams();

        const gs = this.app.scene.gsplat;
        gs.lodRangeMin = Math.min(range[0] + 1, range[1]);
        gs.lodRangeMax = range[1];

        const applyToComponent = (gsplat) => {
            if (!gsplat) return;
            gsplat.lodBaseDistance = lod.baseDistance;
            gsplat.lodMultiplier = lod.multiplier;
        };
        applyToComponent(this.entity.gsplat);
        for (let i = 0; i < this._children.length; i++) {
            applyToComponent(this._children[i]?.gsplat);
        }

        this._loadingComplete = true;

        if (this._lodWidenTimer) {
            clearTimeout(this._lodWidenTimer);
        }
        this._lodWidenTimer = setTimeout(() => {
            this._lodWidenTimer = null;
            // Re-resolve in case the user changed preset during the easing
            // window; _applyPreset uses the current preset's range/params.
            this._applyPreset();
        }, 2000);

        if (this._loadingSafetyTimer) {
            clearTimeout(this._loadingSafetyTimer);
            this._loadingSafetyTimer = null;
        }

        if (this.app && this.app.systems && this.app.systems.gsplat && this.app.systems.gsplat.off) {
            this.app.systems.gsplat.off('frame:ready', this._onGsplatFrameReady, this);
        }

        const el = this._loadingOverlay;
        if (!el) return;
        el.style.opacity = '0';
        setTimeout(() => {
            if (el && el.parentNode) el.parentNode.removeChild(el);
            if (this._loadingOverlay === el) this._loadingOverlay = null;
        }, 700);
    }

    _createCameraPosOverlay() {
        const el = document.createElement('div');
        Object.assign(el.style, {
            position: 'fixed',
            bottom: '12px',
            left: '12px',
            padding: '6px 10px',
            background: 'rgba(0, 0, 0, 0.6)',
            color: '#fff',
            fontFamily: 'monospace',
            fontSize: '13px',
            borderRadius: '4px',
            zIndex: '10000',
            pointerEvents: 'none',
            lineHeight: '1.4'
        });
        el.id = 'camera-pos-overlay';
        document.body.appendChild(el);
        this._cameraPosEl = el;
    }

    update() {
        const rendered = this.app.stats.frame.gsplats || 0;
        this.app.fire('ui:updateStats', rendered);

        // if (this._cameraPosEl) {
        //     const cameras = this.app.systems.camera.cameras;
        //     if (cameras.length > 0) {
        //         const pos = cameras[0].entity.getPosition();
        //         this._cameraPosEl.textContent =
        //             `cam  x: ${pos.x.toFixed(2)}  y: ${pos.y.toFixed(2)}  z: ${pos.z.toFixed(2)}`;
        //     }
        // }
    }

    onDestroy() {
        if (this._cameraPosEl) {
            this._cameraPosEl.remove();
            this._cameraPosEl = null;
        }

        if (this._loadingSafetyTimer) {
            clearTimeout(this._loadingSafetyTimer);
            this._loadingSafetyTimer = null;
        }
        if (this._lodWidenTimer) {
            clearTimeout(this._lodWidenTimer);
            this._lodWidenTimer = null;
        }
        if (this.app && this.app.systems && this.app.systems.gsplat && this.app.systems.gsplat.off) {
            this.app.systems.gsplat.off('frame:ready', this._onGsplatFrameReady, this);
        }
        if (this._loadingOverlay && this._loadingOverlay.parentNode) {
            this._loadingOverlay.parentNode.removeChild(this._loadingOverlay);
        }
        this._loadingOverlay = null;

        if (this._settingsOverlay && this._settingsOverlay.parentNode) {
            this._settingsOverlay.parentNode.removeChild(this._settingsOverlay);
        }
        this._settingsOverlay = null;

        this.app.off('preset:ultra');
        this.app.off('preset:high');
        this.app.off('preset:medium');
        this.app.off('preset:low');
        this.app.off('colorize:toggle');

        // unload/remove assets
        for (let i = 0; i < this._assets.length; i++) {
            const a = this._assets[i];
            if (a) {
                a.unload();
                this.app.assets.remove(a);
            }
        }
        this._assets.length = 0;

        // remove gsplat component from entity if present
        if (this.entity.gsplat) {
            this.entity.removeComponent('gsplat');
        }

        // destroy created children
        for (let j = 0; j < this._children.length; j++) {
            const c = this._children[j];
            if (c && c.destroy) c.destroy();
        }
        this._children.length = 0;
    }
}

export { StreamedGsplat };
