use adw::{Toast, ToastOverlay};
use gtk::prelude::*;
use gtk::{Box as GBox, Image, Label, Orientation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToastVariant {
    Info,
    Success,
    Warning,
    Error,
}

impl ToastVariant {
    fn css_class(self) -> &'static str {
        match self {
            Self::Info => "toast-info",
            Self::Success => "toast-success",
            Self::Warning => "toast-warning",
            Self::Error => "toast-error",
        }
    }

    fn icon_name(self) -> &'static str {
        match self {
            Self::Info => "dialog-information-symbolic",
            Self::Success => "object-select-symbolic",
            Self::Warning => "dialog-warning-symbolic",
            Self::Error => "dialog-error-symbolic",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToastMessage {
    pub variant: ToastVariant,
    pub text: String,
}

impl ToastMessage {
    pub(crate) fn info(text: impl Into<String>) -> Self {
        Self {
            variant: ToastVariant::Info,
            text: text.into(),
        }
    }

    pub(crate) fn success(text: impl Into<String>) -> Self {
        Self {
            variant: ToastVariant::Success,
            text: text.into(),
        }
    }

    pub(crate) fn warning(text: impl Into<String>) -> Self {
        Self {
            variant: ToastVariant::Warning,
            text: text.into(),
        }
    }

    pub(crate) fn error(text: impl Into<String>) -> Self {
        Self {
            variant: ToastVariant::Error,
            text: text.into(),
        }
    }

    pub(crate) fn timeout_seconds(&self) -> u32 {
        match self.variant {
            ToastVariant::Info | ToastVariant::Success => 4,
            ToastVariant::Warning => 6,
            ToastVariant::Error => 8,
        }
    }

    pub(crate) fn display_text(&self) -> String {
        self.text.clone()
    }
}

#[derive(Clone)]
pub(crate) struct ToastManager {
    overlay: ToastOverlay,
}

impl ToastManager {
    pub(crate) fn new(overlay: &ToastOverlay) -> Self {
        Self {
            overlay: overlay.clone(),
        }
    }

    pub(crate) fn show(&self, message: ToastMessage) {
        show_toast(&self.overlay, message);
    }

    pub(crate) fn error(&self, text: impl Into<String>) {
        self.show(ToastMessage::error(text));
    }
}

pub(crate) fn show_toast(overlay: &ToastOverlay, message: ToastMessage) {
    let toast = Toast::new("");
    let content = GBox::new(Orientation::Horizontal, 10);
    content.add_css_class("toast-content");
    content.add_css_class(message.variant.css_class());

    let icon_shell = GBox::new(Orientation::Horizontal, 0);
    icon_shell.add_css_class("toast-icon-shell");
    icon_shell.set_halign(gtk::Align::Center);
    icon_shell.set_valign(gtk::Align::Center);

    let icon = Image::from_icon_name(message.variant.icon_name());
    icon.add_css_class("toast-icon");
    icon.set_pixel_size(16);
    icon_shell.append(&icon);
    content.append(&icon_shell);

    let label = Label::new(Some(&message.display_text()));
    label.add_css_class("toast-message");
    label.set_ellipsize(gtk::pango::EllipsizeMode::None);
    label.set_hexpand(true);
    label.set_max_width_chars(52);
    label.set_wrap(true);
    label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
    label.set_xalign(0.0);
    content.append(&label);

    toast.set_custom_title(Some(&content));
    toast.set_timeout(message.timeout_seconds());
    overlay.add_toast(toast);
}

pub(crate) fn surface_label_error(
    label: &Label,
    toast_manager: &ToastManager,
    text: impl Into<String>,
) {
    let text = text.into();
    label.set_text(&text);
    toast_manager.error(text);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_variants_use_expected_timeouts() {
        assert_eq!(ToastMessage::info("Saved").timeout_seconds(), 4);
        assert_eq!(ToastMessage::success("Done").timeout_seconds(), 4);
        assert_eq!(ToastMessage::warning("Check setup").timeout_seconds(), 6);
        assert_eq!(ToastMessage::error("Failed").timeout_seconds(), 8);
    }

    #[test]
    fn toast_variants_keep_copy_clean() {
        assert_eq!(
            ToastMessage::success("Chat finished").display_text(),
            "Chat finished"
        );
        assert_eq!(
            ToastMessage::error("Clone failed").display_text(),
            "Clone failed"
        );
        assert_eq!(
            ToastMessage::warning("Check setup").display_text(),
            "Check setup"
        );
    }

    #[test]
    fn toast_variants_have_distinct_visual_metadata() {
        assert_eq!(ToastVariant::Info.css_class(), "toast-info");
        assert_eq!(ToastVariant::Success.css_class(), "toast-success");
        assert_eq!(ToastVariant::Warning.css_class(), "toast-warning");
        assert_eq!(ToastVariant::Error.css_class(), "toast-error");

        assert_eq!(
            ToastVariant::Info.icon_name(),
            "dialog-information-symbolic"
        );
        assert_eq!(ToastVariant::Success.icon_name(), "object-select-symbolic");
        assert_eq!(ToastVariant::Warning.icon_name(), "dialog-warning-symbolic");
        assert_eq!(ToastVariant::Error.icon_name(), "dialog-error-symbolic");
    }
}
