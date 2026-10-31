///|
/// Keyboard-focusable wrapper around the moui_3d viewport host.
///
/// The addon's `three_d_viewport` node never claims focus, and MoUI only
/// routes keyboard events to the focused element, so WASD would be dropped.
/// This node keeps the addon's platform-view placement (same id/kind, so the
/// web plugin keeps driving it) while adding:
/// - `focusable`: pointer-down inside the viewport commits focus here;
/// - `ShortcutScope`: every key (down and up) reaches this node through the
///   runtime's shortcut pass, which the app turns into movement messages.
priv struct FocusViewportNode {
  binding : @moui_3d.ThreeDViewportBinding
  semantics_label : String
}

///|
impl @core.ViewNode for FocusViewportNode with fn identity(_self) {
  @core.ViewIdentity::new(kind="FocusThreeDViewport")
}

///|
impl @core.ViewNode for FocusViewportNode with fn declaration(_self) {
  @core.ViewDeclaration::uncacheable()
}

///|
impl @core.ViewNode for FocusViewportNode with fn layout(_self, context) {
  let width = if context.constraints.max.width > 1.0e8 {
    320.0
  } else {
    context.constraints.max.width
  }
  // Unlike the addon viewport (capped at 360px for catalog pages), the game
  // surface fills whatever the layout gives it so the character is readable.
  let aspect_height = width * 0.62
  let height = if context.constraints.max.height > 1.0e8 {
    aspect_height.min(720.0)
  } else {
    context.constraints.max.height
  }
  @core.ViewLayoutResult::new(
    size=context.constraints.constrain(@core.Size::new(width~, height~)),
  )
}

///|
impl @core.ViewNode for FocusViewportNode with fn platform_views(self, context) {
  let revision = match self.binding.snapshot() {
    Some(snapshot) => snapshot.scene_revision().to_string()
    None => "0"
  }
  [
    @core.PlatformViewPlacement::new(
      id="moui-3d-viewport",
      kind="moui_3d_viewport",
      frame=context.frame,
      clip=Some(context.frame),
      properties=[
        @core.PlatformViewProperty::new(key="scene_revision", value=revision),
      ],
    ),
  ]
}

///|
impl @core.ViewNode for FocusViewportNode with fn semantics(self) {
  @core.ViewSemanticsInfo::new(
    composition=Boundary,
    role=Group,
    label=self.semantics_label,
    description="Interactive 3D character viewport",
  )
}

///|
impl @core.ViewNode for FocusViewportNode with fn focusable(_self) {
  true
}

///|
impl @core.ViewNode for FocusViewportNode with fn keyboard_policy(_self) {
  @core.ShortcutScope
}

///|
/// The viewport host as a focusable keyboard target. `on_event` receives the
/// addon's decoded pointer/wheel/focus events and `on_key` receives every
/// keyboard press/release while the shortcut pass reaches this node.
pub fn[Msg] focusable_three_d_viewport(
  binding~ : @moui_3d.ThreeDViewportBinding,
  snapshot~ : @moui_3d.ViewportSnapshot,
  semantics_label~ : String = "3D viewport",
  on_event~ : ((@moui_3d.ViewportEvent) -> Msg)? = None,
  on_key~ : ((String, Bool) -> Msg)? = None,
) -> @moui.View[Msg] {
  ignore(binding.publish(snapshot))
  @core.View::from_node(
    FocusViewportNode::{ binding, semantics_label, },
    event=(_node, context) =>
      match context.event {
        @core.Keyboard(event) =>
          match on_key {
            Some(handler) =>
              @core.ViewEventResult::message(
                handler(event.key, event.pressed),
              )
            None => @core.ViewEventResult::ignored()
          }
        @core.PlatformView(view_id, event) =>
          match (view_id, on_event) {
            ("moui-3d-viewport", Some(handler)) =>
              match @moui_3d.decode_viewport_event(event) {
                Some(value) => @core.ViewEventResult::message(handler(value))
                None => @core.ViewEventResult::ignored()
              }
            _ => @core.ViewEventResult::ignored()
          }
        _ => @core.ViewEventResult::ignored()
      },
  )
}
