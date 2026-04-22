import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';

import { ObjectPrototype } from './utils/objectPrototype.js';

const WINDOW_OVERLAY_FADE_TIME = 200;

export class CustomWorkspace {
    constructor(settings) {
        this._settings = settings;
        this._objectPrototype = null;
        this._appsGridShownId = null;
        this._idleId = null;
        this._allWindows = null;
        this._originalCreateBestLayout = null;
        this._enabled = false;
    }

    enable() {
        this._enabled = true;
        this._objectPrototype = new ObjectPrototype();

        this._setupWindowDecorations();

        // Since other extensions (eg, dash-to-panel) could use Workspace.WorkspaceBackground, I can't just remove it any more.
        // Hide the Workspace.WorkspaceBackground after be initialized
        const self = this;
        this._objectPrototype.injectOrOverrideFunction(Workspace.WorkspaceBackground.prototype, '_init', true, function() {
            self._showHideWorkspaceBackground(this);
        });

        this._objectPrototype.injectOrOverrideFunction(Workspace.Workspace.prototype, 'prepareToLeaveOverview', true, function() {
            for (let i = 0; i < this._windows.length; i++) {
                const windowPreview = this._windows[i];
                self._animateFromOverview(windowPreview, true);
            }
        });

        this._setupGroupByApp();
    }

    disable() {
        this._enabled = false;
        
        if (this._objectPrototype) {
            this._objectPrototype.removeInjections(Workspace.WorkspaceBackground.prototype);
            this._objectPrototype.removeInjections(Workspace.Workspace.prototype);
            this._objectPrototype = null;
        }

        if (this._originalCreateBestLayout) {
            Workspace.WorkspaceLayout.prototype._createBestLayout = this._originalCreateBestLayout;
            this._originalCreateBestLayout = null;
        }

        if (this._appsGridShownId) {
            Main.overview.dash.showAppsButton.disconnect(this._appsGridShownId);
            this._appsGridShownId = null;
        }

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = null;
        }

        this._restoreWindowsVisible();
    }

    // --- Private Methods ---

    _showHideWorkspaceBackground(workspaceBackground) {
        if (!this._settings) return;
        
        const hide_background = this._settings.get_boolean('hide-background');
        if (hide_background) {
            workspaceBackground.hide();
        } else {
            workspaceBackground.show();
        }
    }

    _animateFromOverview(windowPreview, animate) {
        const metaWorkspace = windowPreview._workspace.metaWorkspace;
        // Seems that if metaWorkspace is null, the current workspace is active?
        // See: workspace.Workspace#_isMyWindow() and workspacesView.SecondaryMonitorDisplay#_updateWorkspacesView()
        if (metaWorkspace !== null && !metaWorkspace.active) {
            return;
        }

        // Hide title and button gradually even if metaWorkspace is null
        const toHide = [windowPreview._title, windowPreview._closeButton];
        toHide.forEach(a => {
            if (!a) return;
            a.opacity = 255;
            a.ease({
                opacity: 0,
                duration: animate ? WINDOW_OVERLAY_FADE_TIME : 0,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO
            });
        });
    }

    // TODO: better to hide the titles and close buttons before entering the app grid,
    // otherwise the titles and close buttons on windows are very noticeable.
    _setupWindowDecorations() {
        this._appsGridShownId = Main.overview.dash.showAppsButton.connect('notify::checked', () => {
            if (Main.overview.dash.showAppsButton.checked) {
                this._allWindows = [];
                // Have to do this when the event loop is idle and to wait the underlying higher priority operations are completed
                this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                    // Critical safety check: extension might have been disabled while waiting for idle
                    if (!this._enabled) {
                        return GLib.SOURCE_REMOVE;
                    }

                    // monitors
                    const workspacesViews = Main.overview._overview._controls._workspacesDisplay._workspacesViews;
                    if (workspacesViews && workspacesViews.length) {
                        workspacesViews.forEach(wv => {
                            const workspaces = wv._workspaces;
                            // It's possible no workspace view bars on the second monitor
                            if (workspaces && workspaces.length) {
                                workspaces.forEach(workspace => {
                                    const windows = workspace._windows;
                                    if (windows && windows.length) {
                                        windows.forEach(windowPreview => {
                                            if (windowPreview._closeButton && windowPreview._title) {
                                                windowPreview._closeButton._originalVisibleAWSM = windowPreview._closeButton.visible;
                                                windowPreview._title._originalVisibleAWSM = windowPreview._title.visible;
                                                // Use opacity instead of hide() to avoid layout passes during transitions
                                                windowPreview._closeButton.opacity = 0;
                                                windowPreview._title.opacity = 0;
                                                this._allWindows.push(windowPreview);
                                            }
                                        });
                                    }
                                });
                            }
                        });
                    }
                    this._idleId = null;
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._restoreWindowsVisible();
            }
        });
    }

    _restoreWindowsVisible() {
        if (this._allWindows && this._allWindows.length) {
            this._allWindows.forEach(windowPreview => {
                if (windowPreview && windowPreview._closeButton && windowPreview._title) {
                    windowPreview._closeButton.opacity = 255;
                    windowPreview._title.opacity = 255;
                    windowPreview._closeButton.visible = windowPreview._closeButton._originalVisibleAWSM;
                    windowPreview._title.visible = windowPreview._title._originalVisibleAWSM;
                }
            });
            this._allWindows = null;
        }
    }

    _setupGroupByApp() {
        // Group by app: monkey-patch to reorder windows before layout calculation
        const windowTracker = Shell.WindowTracker.get_default();
        this._originalCreateBestLayout = Workspace.WorkspaceLayout.prototype._createBestLayout;

        const self = this;
        Workspace.WorkspaceLayout.prototype._createBestLayout = function(area) {
            if (!self._settings || !self._settings.get_boolean('group-by-app'))
                return self._originalCreateBestLayout.call(this, area);

            // 1. Group windows by app, ordering groups by the oldest window's sequence
            const groups = new Map();
            for (const wp of this._sortedWindows) {
                const mw = this._windows.get(wp).metaWindow;
                const app = windowTracker.get_window_app(mw);
                const id = app ? app.get_id() : (mw.get_wm_class() || 'unknown');
                
                if (!groups.has(id))
                    groups.set(id, { wins: [], seq: mw.get_stable_sequence() });
                
                const g = groups.get(id);
                g.wins.push(wp);
                g.seq = Math.min(g.seq, mw.get_stable_sequence());
            }

            // 2. Rebuild _sortedWindows in grouped order
            const sorted = [...groups.values()]
                .sort((a, b) => a.seq - b.seq)
                .flatMap(g => g.wins);

            this._sortedWindows.length = 0;
            sorted.forEach(w => this._sortedWindows.push(w));

            // 3. Spoof _cachedBoundingBox to force horizontal order in the layout calculation.
            // windowCenter.x = box.x + width/2, windowCenter.y = box.y + height/2
            // We use a large arbitrary step (1000) for X to ensure the native placement algorithm
            // strictly treats them as non-overlapping items in a left-to-right sequence.
            const saved = new Map();
            let fx = 0;
            for (const wp of this._sortedWindows) {
                if (!wp._cachedBoundingBox) continue;
                
                saved.set(wp, { x: wp._cachedBoundingBox.x, y: wp._cachedBoundingBox.y });
                wp._cachedBoundingBox.x = fx - wp._cachedBoundingBox.width / 2;
                wp._cachedBoundingBox.y = -wp._cachedBoundingBox.height / 2;
                fx += 1000;
            }

            // 4. Call original layout logic with spoofed values
            const result = self._originalCreateBestLayout.call(this, area);

            // 5. Restore original coordinates
            saved.forEach((orig, wp) => {
                wp._cachedBoundingBox.x = orig.x;
                wp._cachedBoundingBox.y = orig.y;
            });

            return result;
        };
    }

}
