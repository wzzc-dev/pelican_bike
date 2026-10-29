///|
fn main {
  @runtime.run_app(
    "Pelican on a Bicycle",
    @runtime.new_program_with_dimensions(
      program=@pelican_app.program(),
      width=1080.0,
      height=700.0,
    ),
  )
  .render_all(@render_skia.from_env(platform=MacOS))
  .backend(@macos.entry())
  .run()
}
