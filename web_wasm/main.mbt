///|
fn main {
  let binding = @moui_3d.ThreeDViewportBinding::new()
  let viewport_host = @moui_3d.ThreeDViewportHost::new(binding~)
  let provider = @three_d_web.create_host_provider()
  @three_d_render.connect_viewport_host(
    provider,
    viewport_host,
    unavailable_reason="WebGPU host imports or adapter are unavailable",
  )
  @runtime.run_app(
    "Sun Wukong — MoUI 3D",
    @runtime.new_program_with_dimensions(
      program=@wukong_app.program_with_binding(
        binding,
        environment=@web.app_environment(),
      ),
      width=1080.0,
      height=700.0,
    ),
  )
  .render_all(@webgpu_adapter.from_env())
  .backend(
    @web.entry(
      options=@web.WebAppOptions::new(platform_view_plugins=[
        @three_d_web_backend.plugin(host=Some(viewport_host)),
      ]),
    ),
  )
  .run()
}
