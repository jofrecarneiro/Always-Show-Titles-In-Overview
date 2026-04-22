// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as WindowPreview from 'resource:///org/gnome/shell/ui/windowPreview.js';

import {CustomWorkspace} from './workspace.js';
import {ObjectPrototype} from './utils/objectPrototype.js';

// Static flags — pure data, no dynamic state
const updateWindowPreviewFlags = {
    ICON_SHOW_OR_HIDE_WHEN_FULLSCREEN:          1 << 0,
    ICON_SHOW_OR_HIDE_FOR_VIDEO_PLAYER:         1 << 1,
    TITLE_MOVE_TO_BOTTOM_WHEN_FULLSCREEN:       1 << 2,
    TITLE_MOVE_TO_BOTTOM_FOR_VIDEO_PLAYER:      1 << 3,
};

const POSITION_CENTER = 0.5;
const POSITION_BOTTOM = 1.0;

export default class AlwaysShowTitlesInOverviewExtension extends Extension {

    enable() {
        this._settings = this.getSettings(
            'org.gnome.shell.extensions.always-show-titles-in-overview');

        this._customWorkspace = new CustomWorkspace(this._settings);
        this._customWorkspace.enable();

        this._objectPrototype = new ObjectPrototype();
        this._windowTracker = Shell.WindowTracker.get_default();

        this._setupWindowPreviewInit();
        this._setupAdjustOverlayOffsets();
        this._setupShowOverlay();
        this._setupHideOverlay();

        // Update all previews when settings change
        this._settingsIds = [];
        const settingsToWatch = [
            'window-title-position',
            'app-icon-position',
            'show-app-icon',
            'title-font-size',
            'always-show-window-closebuttons'
        ];
        settingsToWatch.forEach(key => {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._updateAllWindows();
            }));
        });
    }

    disable() {
        if (this._settingsIds) {
            this._settingsIds.forEach(id => this._settings.disconnect(id));
            this._settingsIds = null;
        }

        if (this._objectPrototype) {
            this._objectPrototype.removeInjections(WindowPreview.WindowPreview.prototype);
            this._objectPrototype = null;
        }

        if (this._customWorkspace) {
            this._customWorkspace.disable();
            this._customWorkspace = null;
        }

        if (this._windowTracker) {
            this._windowTracker = null;
        }

        if (this._settings) {
            this._settings = null;
        }
    }

    _updateAllWindows() {
        // Find all WindowPreview instances. This is a bit hacky but necessary to update existing previews.
        // Usually they are children of Workspace actors.
        const workspacesViews = Main.overview._overview._controls._workspacesDisplay._workspacesViews;
        workspacesViews.forEach(wv => {
            wv._workspaces.forEach(ws => {
                ws._windows.forEach(wp => {
                    this._applyTitleFontSize(wp);
                    this._updateAppIcon(wp);
                    this._updateTitle(wp);
                    this._applyOverlayLayout(wp);
                });
            });
        });
    }

    // --- Monkey-patch setup methods ---

    _setupWindowPreviewInit() {
        const self = this;

        this._objectPrototype.injectOrOverrideFunction(
            WindowPreview.WindowPreview.prototype, '_init', true,
            function(_animate) {
                if (this._windowCanClose() && self._settings.get_boolean('always-show-window-closebuttons')) {
                    this._closeButton.show();
                }

                this._title.show();
                self._applyTitleFontSize(this);

                // Remove original title offset constraints. Our layout engine handles Y positioning now.
                const title_constraints = this._title.get_constraints();
                for (const constraint of title_constraints) {
                    if (constraint instanceof Clutter.BindConstraint) {
                        const coordinate = constraint.coordinate
                        if (coordinate === Clutter.BindCoordinate.Y) {
                            constraint.set_offset(0)
                        }
                    }
                }

                self._updateAppIcon(this);
                self._updateTitle(this);

                let flags = 0;
                const iconWhenFullscreen = self._settings.get_boolean('do-not-show-app-icon-when-fullscreen');
                const iconForVideoPlayer = self._settings.get_boolean('hide-icon-for-video-player');
                if (iconWhenFullscreen) flags |= updateWindowPreviewFlags.ICON_SHOW_OR_HIDE_WHEN_FULLSCREEN;
                if (iconForVideoPlayer) flags |= updateWindowPreviewFlags.ICON_SHOW_OR_HIDE_FOR_VIDEO_PLAYER;
                
                const titleWhenFullscreen = self._settings.get_boolean('move-window-title-to-bottom-when-fullscreen');
                const titleForVideoPlayer = self._settings.get_boolean('move-window-title-to-bottom-for-video-player');
                if (titleWhenFullscreen) flags |= updateWindowPreviewFlags.TITLE_MOVE_TO_BOTTOM_WHEN_FULLSCREEN;
                if (titleForVideoPlayer) flags |= updateWindowPreviewFlags.TITLE_MOVE_TO_BOTTOM_FOR_VIDEO_PLAYER;
                
                self._hideOrMove(this, flags);

                // Dynamically act on text scaling changes
                const updateTranslations = () => {
                    self._applyOverlayLayout(this);
                };
                this._title.connectObject('notify::height', updateTranslations, this);
                this._icon.connectObject('notify::height', updateTranslations, this);
            }
        );
    }

    _setupAdjustOverlayOffsets() {
        const self = this;
        this._objectPrototype.injectOrOverrideFunction(
            WindowPreview.WindowPreview.prototype, '_adjustOverlayOffsets', true,
            function() {
                self._applyOverlayLayout(this);
            }
        );
    }

    _setupShowOverlay() {
        const self = this;

        this._objectPrototype.injectOrOverrideFunction(
            WindowPreview.WindowPreview.prototype, 'showOverlay', false,
            function(animate) {
                if (!this._overlayEnabled || this._overlayShown)
                    return;

                this._overlayShown = true;
                this._restack();

                const ongoingTransition = this._title.get_transition('opacity');
                if (animate && ongoingTransition &&
                    ongoingTransition.get_interval().peek_final_value() === 255)
                    return;

                const alwaysShowWindowClosebuttons = self._settings.get_boolean('always-show-window-closebuttons');
                if (!alwaysShowWindowClosebuttons) {
                    const toShow = this._windowCanClose() ? [this._closeButton] : [];

                    toShow.forEach(a => {
                        a.opacity = 0;
                        a.show();
                        a.ease({
                            opacity: 255,
                            duration: animate ? WindowPreview.WINDOW_OVERLAY_FADE_TIME : 0,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    });
                }
                
                const [width, height] = this.window_container.get_size();
                const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
                const window_active_size_inc = self._settings.get_int('window-active-size-inc');
                const activeExtraSize = window_active_size_inc * 2 * scaleFactor;
                const origSize = Math.max(width, height);
                const scale = (origSize + activeExtraSize) / origSize;

                // Trigger _adjustOverlayOffsets() via notify::scale-x
                this.window_container.ease({
                    scale_x: scale,
                    scale_y: scale,
                    duration: animate ? WindowPreview.WINDOW_SCALE_TIME : 0,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });

                this.emit('show-chrome');

                // Explicitly call the layout recalculation 
                self._applyOverlayLayout(this);
            }
        );
    }

    _setupHideOverlay() {
        const self = this;

        this._objectPrototype.injectOrOverrideFunction(
            WindowPreview.WindowPreview.prototype, 'hideOverlay', false,
            function(animate) {
                if (!this._overlayShown)
                    return;

                this._overlayShown = false;
                this._restack();

                const ongoingTransition = this._title.get_transition('opacity');
                if (animate && ongoingTransition &&
                    ongoingTransition.get_interval().peek_final_value() === 0)
                    return;

                const alwaysShowWindowClosebuttons = self._settings.get_boolean('always-show-window-closebuttons');
                if (!alwaysShowWindowClosebuttons) {
                    [this._closeButton].forEach(a => {
                        a.opacity = 255;
                        a.ease({
                            opacity: 0,
                            duration: animate ? WindowPreview.WINDOW_OVERLAY_FADE_TIME : 0,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onComplete: () => a.hide(),
                        });
                    });   
                }
                
                this.window_container.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: animate ? WindowPreview.WINDOW_SCALE_TIME : 0,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });

                self._applyOverlayLayout(this);
            }
        );
    }

    // --- Layout Engine Methods ---

    _applyOverlayLayout(windowPreview) {
        if (!windowPreview || !windowPreview.get_stage()) return;
        
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        
        // Base gap relative to DPI
        const GAP = 2 * scaleFactor; 
        
        const titleHeight = windowPreview._title.get_height();
        
        const titlePos = this._settings.get_string('window-title-position');
        const iconPos = this._settings.get_string('app-icon-position');
        
        const titleFactor = this._positionFactor(titlePos);
        const iconFactor = this._positionFactor(iconPos);
        
        if (titleFactor === iconFactor) {
            // Stacked Block mode: User wants both at Center or both at Bottom.
            // We lock them together. Title goes BELOW Icon to maintain the pattern.
            // NOTE: We assume constraints are already set to titleFactor by _updateAppIcon/_updateTitle
            // which are called from _init or when settings change.
            
            windowPreview._title.translation_y = 0;
            windowPreview._icon.translation_y = -(titleHeight + GAP);
        } else {
            // Independent Zoning Mode: Title and Icon are in entirely different zones.
            // They just snap to their anchors naturally.
            windowPreview._title.translation_y = 0;
            windowPreview._icon.translation_y = 0;
        }
    }

    _applyTitleFontSize(windowPreview) {
        const fontSize = this._settings.get_int('title-font-size');
        // Check if there's actually a font size, zero means default
        if (fontSize && fontSize > 0) {
            windowPreview._title.set_style(`font-size: ${fontSize}pt;`);
        } else {
            windowPreview._title.set_style(null);
        }
        if (windowPreview._title.get_stage()) {
            windowPreview._title.ensure_style();
        }
    }

    _clearBindConstraints(widget) {
        for (const constraint of [...widget.get_constraints()]) {
            if (constraint instanceof Clutter.BindConstraint &&
                (constraint.coordinate === Clutter.BindCoordinate.Y || 
                 constraint.coordinate === Clutter.BindCoordinate.POSITION)) {
                widget.remove_constraint(constraint);
            }
        }
    }

    _setYAlign(widget, factor) {
        for (const constraint of widget.get_constraints()) {
            if (constraint instanceof Clutter.AlignConstraint &&
                constraint.align_axis === Clutter.AlignAxis.Y_AXIS) {
                if (constraint.factor !== factor) {
                    constraint.set_factor(factor);
                }
                return;
            }
        }
        
        const parent = widget.get_parent();
        if (parent) {
            const c = new Clutter.AlignConstraint({ source: parent, align_axis: Clutter.AlignAxis.Y_AXIS, factor });
            widget.add_constraint(c);
        }
    }

    _positionFactor(positionString) {
        return positionString === 'Center' ? POSITION_CENTER : POSITION_BOTTOM;
    }

    _hideOrMove(windowPreview, flags) {
        const window_is_fullscreen = windowPreview.metaWindow.is_fullscreen()
        if (window_is_fullscreen) {
            if (flags & updateWindowPreviewFlags.ICON_SHOW_OR_HIDE_WHEN_FULLSCREEN) {
                windowPreview._icon.hide();
            }
            if (flags & updateWindowPreviewFlags.TITLE_MOVE_TO_BOTTOM_WHEN_FULLSCREEN) {
                this._setYAlign(windowPreview._title, POSITION_BOTTOM);
            }
            return;
        }

        if (flags & (updateWindowPreviewFlags.ICON_SHOW_OR_HIDE_FOR_VIDEO_PLAYER 
                    | updateWindowPreviewFlags.TITLE_MOVE_TO_BOTTOM_FOR_VIDEO_PLAYER)) {
            const app = this._windowTracker.get_window_app(windowPreview.metaWindow);
            const app_info = app?.get_app_info();
            let recheck = false;
            const categories = app_info?.get_categories();
            
            if (categories) {
                const categoriesArr = categories.split(';')
                for (const category of categoriesArr) {
                    if (category === 'Video' || category === 'TV') {
                        if (flags & updateWindowPreviewFlags.ICON_SHOW_OR_HIDE_FOR_VIDEO_PLAYER) {
                            windowPreview._icon.hide();
                        }
                        if (flags & updateWindowPreviewFlags.TITLE_MOVE_TO_BOTTOM_FOR_VIDEO_PLAYER) {
                            this._setYAlign(windowPreview._title, POSITION_BOTTOM);
                        }
                        return;
                    } 
                    if (category === 'Player') {
                        recheck = true;
                    }
                }
            }

            if (recheck) {
                const supported_types = app_info?.get_supported_types();
                if (supported_types) {
                    for (const supported_type of supported_types) {
                        if (supported_type.startsWith('video/')) {
                            if (flags & updateWindowPreviewFlags.ICON_SHOW_OR_HIDE_FOR_VIDEO_PLAYER) {
                                windowPreview._icon.hide();
                            }
                            if (flags & updateWindowPreviewFlags.TITLE_MOVE_TO_BOTTOM_FOR_VIDEO_PLAYER) {
                                this._setYAlign(windowPreview._title, POSITION_BOTTOM);
                            }
                            return;
                        }
                    }
                }
            }
        }
    }

    _updateTitle(windowPreview) {
        const windowTitlePosition = this._settings.get_string('window-title-position');
        this._clearBindConstraints(windowPreview._title);
        this._setYAlign(windowPreview._title, this._positionFactor(windowTitlePosition));
    }

    _updateAppIcon(windowPreview) {
        const show_app_icon = this._settings.get_boolean('show-app-icon');
        if (!show_app_icon) {
            windowPreview._icon.hide();
            return;
        }

        const appIconPosition = this._settings.get_string('app-icon-position');
        this._clearBindConstraints(windowPreview._icon);
        this._setYAlign(windowPreview._icon, this._positionFactor(appIconPosition));
    }

}