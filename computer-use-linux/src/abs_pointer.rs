//! Direct uinput **absolute** pointer.
//!
//! ydotool's virtual device is relative-only (`EV=7`: SYN|KEY|REL), so its
//! `--absolute` is faked as "pin-to-corner + relative move", which the
//! compositor then distorts with pointer acceleration and fractional display
//! scaling — clicks land in the wrong place on multi-monitor / HiDPI setups.
//!
//! Here we create our own uinput device that exposes a true `ABS_X`/`ABS_Y`
//! axis whose range matches the full screenshot's pixel dimensions. The
//! compositor maps that range across its logical output layout. Callers keep
//! using capture-pixel coordinates, which can differ from logical coordinates
//! on scaled outputs. Returned landings describe the emitted coordinates;
//! they are not a readback of the compositor's actual pointer position.

use std::thread::sleep;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use evdev::{
    uinput::VirtualDevice, AbsInfo, AbsoluteAxisCode, AttributeSet, EventType, InputEvent, KeyCode,
    PropType, UinputAbsSetup,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use = "pointer input may be clamped; inspect requested and emitted coordinates"]
pub(crate) struct PointerLanding {
    pub(crate) requested: (i32, i32),
    pub(crate) emitted: (i32, i32),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AbsPointerGeometry {
    max_x: i32,
    max_y: i32,
}

impl AbsPointerGeometry {
    fn from_dimensions(width: i32, height: i32) -> Self {
        Self {
            max_x: width.max(1).saturating_sub(1),
            max_y: height.max(1).saturating_sub(1),
        }
    }

    fn axis_maxima(self) -> (i32, i32) {
        (self.max_x, self.max_y)
    }

    fn matches_dimensions(self, width: i32, height: i32) -> bool {
        self == Self::from_dimensions(width, height)
    }

    fn clamp_coordinates(self, x: i32, y: i32) -> (i32, i32) {
        (x.clamp(0, self.max_x), y.clamp(0, self.max_y))
    }

    fn landing_for(self, x: i32, y: i32) -> PointerLanding {
        PointerLanding {
            requested: (x, y),
            emitted: self.clamp_coordinates(x, y),
        }
    }
}

pub struct AbsPointer {
    device: VirtualDevice,
    geometry: AbsPointerGeometry,
}

impl AbsPointer {
    /// Create the absolute pointer sized to the capture's `width`×`height`.
    /// Waits 500 ms for libinput to enumerate the device before its first event.
    pub fn create(width: i32, height: i32) -> Result<Self> {
        let geometry = AbsPointerGeometry::from_dimensions(width, height);
        let (max_x, max_y) = geometry.axis_maxima();
        // value, min, max, fuzz, flat, resolution. resolution=1 unit/px.
        let abs_x =
            UinputAbsSetup::new(AbsoluteAxisCode::ABS_X, AbsInfo::new(0, 0, max_x, 0, 0, 1));
        let abs_y =
            UinputAbsSetup::new(AbsoluteAxisCode::ABS_Y, AbsInfo::new(0, 0, max_y, 0, 0, 1));
        let keys =
            AttributeSet::from_iter([KeyCode::BTN_LEFT, KeyCode::BTN_RIGHT, KeyCode::BTN_MIDDLE]);
        // INPUT_PROP_DIRECT marks the device as a direct (absolute) pointer so
        // libinput maps its axes to screen coordinates rather than treating it
        // as a relative touchpad.
        let props = AttributeSet::from_iter([PropType::DIRECT]);

        let device = VirtualDevice::builder()
            .context("uinput builder (is /dev/uinput writable?)")?
            .name("codex-computer-use-linux absolute pointer")
            .with_properties(&props)?
            .with_absolute_axis(&abs_x)?
            .with_absolute_axis(&abs_y)?
            .with_keys(&keys)?
            .build()
            .context("failed to create uinput absolute pointer device")?;

        // Give udev/libinput time to enumerate the new device.
        sleep(Duration::from_millis(500));

        Ok(Self { device, geometry })
    }

    pub fn matches_dimensions(&self, width: i32, height: i32) -> bool {
        self.geometry.matches_dimensions(width, height)
    }

    /// Move the pointer to capture-pixel coordinates `(x, y)` and report
    /// both the requested point and the values emitted after edge clamping.
    pub(crate) fn move_to(&mut self, x: i32, y: i32) -> Result<PointerLanding> {
        let landing = self.geometry.landing_for(x, y);
        let (emitted_x, emitted_y) = landing.emitted;
        self.device
            .emit(&[
                InputEvent::new_now(EventType::ABSOLUTE.0, AbsoluteAxisCode::ABS_X.0, emitted_x),
                InputEvent::new_now(EventType::ABSOLUTE.0, AbsoluteAxisCode::ABS_Y.0, emitted_y),
            ])
            .context("failed to emit absolute motion")?;
        Ok(landing)
    }

    /// Move to `(x, y)` then press+release `button` `count` times.
    pub(crate) fn click(
        &mut self,
        x: i32,
        y: i32,
        button: PointerButton,
        count: u32,
    ) -> Result<PointerLanding> {
        let landing = self.move_to(x, y)?;
        sleep(Duration::from_millis(30));
        let code = button.key_code();
        for _ in 0..count.max(1) {
            if let Err(error) = self
                .device
                .emit(&[InputEvent::new_now(EventType::KEY.0, code, 1)])
            {
                return Err(self.release_after_error(code, error.into()));
            }
            sleep(Duration::from_millis(30));
            if let Err(error) = self.release_button(code) {
                return Err(self.release_after_error(code, error));
            }
            sleep(Duration::from_millis(40));
        }
        Ok(landing)
    }

    /// Press at `(start)`, move to `(end)`, release — a drag with `button`.
    pub fn drag(
        &mut self,
        start: (i32, i32),
        end: (i32, i32),
        button: PointerButton,
    ) -> Result<()> {
        let code = button.key_code();
        // Drag currently reports backend success only; retain the landing
        // values explicitly so their intentional omission stays visible.
        let _start_landing = self.move_to(start.0, start.1)?;
        sleep(Duration::from_millis(30));
        if let Err(error) = self
            .device
            .emit(&[InputEvent::new_now(EventType::KEY.0, code, 1)])
        {
            return Err(self.release_after_error(code, error.into()));
        }
        sleep(Duration::from_millis(40));
        let _end_landing = match self.move_to(end.0, end.1) {
            Ok(landing) => landing,
            Err(error) => return Err(self.release_after_error(code, error)),
        };
        sleep(Duration::from_millis(40));
        if let Err(error) = self.release_button(code) {
            return Err(self.release_after_error(code, error));
        }
        Ok(())
    }

    fn release_button(&mut self, code: u16) -> Result<()> {
        self.device
            .emit(&[InputEvent::new_now(EventType::KEY.0, code, 0)])
            .context("failed to emit absolute pointer button release")
    }

    fn release_after_error(&mut self, code: u16, error: anyhow::Error) -> anyhow::Error {
        match self.release_button(code) {
            Ok(()) => anyhow!("{error:#}; sent a best-effort button release"),
            Err(release_error) => {
                anyhow!("{error:#}; best-effort button release also failed: {release_error:#}")
            }
        }
    }
}

/// Pointer buttons we can synthesize.
#[derive(Clone, Copy, Debug)]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

impl PointerButton {
    pub fn from_name(name: Option<&str>) -> Option<Self> {
        match name.unwrap_or("left").to_ascii_lowercase().as_str() {
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "middle" => Some(Self::Middle),
            _ => None,
        }
    }

    fn key_code(self) -> u16 {
        match self {
            Self::Left => KeyCode::BTN_LEFT.0,
            Self::Right => KeyCode::BTN_RIGHT.0,
            Self::Middle => KeyCode::BTN_MIDDLE.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AbsPointerGeometry, PointerButton};

    #[test]
    fn axis_range_ends_at_last_desktop_pixel() {
        let geometry = AbsPointerGeometry::from_dimensions(1920, 1080);

        assert_eq!(geometry.axis_maxima(), (1919, 1079));
    }

    #[test]
    fn stale_capture_geometry_is_rejected_before_pointer_reuse() {
        let cached = AbsPointerGeometry::from_dimensions(3840, 2160);

        assert!(cached.matches_dimensions(3840, 2160));
        assert!(!cached.matches_dimensions(2560, 1440));
        assert!(!cached.matches_dimensions(3840, 1080));
    }

    #[test]
    fn pointer_landing_preserves_the_request_and_emitted_coordinates() {
        let geometry = AbsPointerGeometry::from_dimensions(1920, 1080);

        for (requested, emitted) in [
            ((640, 480), (640, 480)),
            ((1920, 1080), (1919, 1079)),
            ((-1, -1), (0, 0)),
            ((i32::MAX, i32::MAX), (1919, 1079)),
        ] {
            let landing = geometry.landing_for(requested.0, requested.1);
            assert_eq!(landing.requested, requested);
            assert_eq!(landing.emitted, emitted);
        }
    }

    #[test]
    fn unsupported_buttons_fall_through_to_other_backends() {
        assert!(matches!(
            PointerButton::from_name(None),
            Some(PointerButton::Left)
        ));
        assert!(matches!(
            PointerButton::from_name(Some("right")),
            Some(PointerButton::Right)
        ));
        assert!(matches!(
            PointerButton::from_name(Some("middle")),
            Some(PointerButton::Middle)
        ));

        for button in ["side", "extra", "forward", "back"] {
            assert!(
                PointerButton::from_name(Some(button)).is_none(),
                "{button} must fall through instead of becoming a left click"
            );
        }
    }
}
