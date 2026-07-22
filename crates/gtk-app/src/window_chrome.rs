use gtk::prelude::*;

pub(crate) fn configure_column_header<W: IsA<gtk::Widget>>(header: &W) {
    header.set_height_request(crate::COLUMN_HEADER_HEIGHT);
    header.set_vexpand(false);

    let gesture = gtk::GestureClick::new();
    gesture.set_button(1);
    gesture.connect_pressed(move |gesture, _presses, x, y| {
        let Some(event) = gesture.current_event() else {
            return;
        };
        let Some(device) = event.device() else {
            return;
        };
        let Some(surface) = gesture
            .widget()
            .and_then(|widget| widget.native())
            .and_then(|native| native.surface())
        else {
            return;
        };
        let Ok(toplevel) = surface.downcast::<gtk::gdk::Toplevel>() else {
            return;
        };
        toplevel.begin_move(&device, 1, x, y, event.time());
    });
    header.add_controller(gesture);
}
