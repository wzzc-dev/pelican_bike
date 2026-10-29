///|
test "scene paints paths and advances with the paint clock" {
  let runtime = @runtime.new_program_with_dimensions(
    program=@app.program(),
    width=1080.0,
    height=700.0,
  )
  let first = runtime.draw_commands()
  assert_true(first.length() > 0)
  assert_true(first.any(command => command is DrawPath(_)))
  let before = path_checksum(first)
  runtime.advance_time(500.0)
  ignore(runtime.draw_frame())
  let after = path_checksum(runtime.draw_commands())
  assert_true(before != after)
}

///|
fn path_checksum(commands : Array[@core.DrawCommand]) -> Double {
  let mut total = 0.0
  let mut count = 0.0
  for command in commands {
    match command {
      DrawPath(spec) => {
        for verb in spec.verbs {
          match verb {
            MoveTo(point) => {
              total = total + point.x + point.y
              count = count + 1.0
            }
            LineTo(point) => {
              total = total + point.x * 1.3 + point.y
              count = count + 1.0
            }
            QuadTo(control, end) => {
              total = total + control.x + end.y
              count = count + 1.0
            }
            CubicTo(first, second, end) => {
              total = total + first.x + second.y + end.x
              count = count + 1.0
            }
            Close => ()
          }
        }
      }
      _ => ()
    }
  }
  total + count * 0.001
}
