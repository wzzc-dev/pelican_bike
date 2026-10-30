///|
/// A looping, paint-only scene: a pelican pedals a bicycle into a sunset.
/// Motion is sampled from the runtime paint clock (`now_ms`), so no host timer
/// or model message is involved; `animated_canvas` keeps frames flowing.
using @views {
  animated_canvas,
  draw_path,
  fill_rect,
  fill_rounded_rect,
  pop_clip,
  pop_opacity,
  pop_transform,
  push_clip,
  push_opacity,
  push_transform,
  stroke_rounded_rect,
}

///|
let stage_width : Double = 1000.0

///|
let stage_height : Double = 640.0

///|
let wheel_radius : Double = 80.0

///|
let rear_hub_x : Double = 330.0

///|
let front_hub_x : Double = 700.0

///|
let hub_y : Double = 478.0

///|
let crank_x : Double = 505.0

///|
let pedal_arm : Double = 30.0

///|
priv struct Palette {
  sky_deep : @graphics.Color
  sky_dusk : @graphics.Color
  sky_rose : @graphics.Color
  sky_warm : @graphics.Color
  sun_core : @graphics.Color
  sun_edge : @graphics.Color
  cloud : @graphics.Color
  hill_far : @graphics.Color
  hill_near : @graphics.Color
  tree : @graphics.Color
  road_top : @graphics.Color
  road_bottom : @graphics.Color
  road_edge : @graphics.Color
  dash : @graphics.Color
  grass : @graphics.Color
  tire : @graphics.Color
  rim : @graphics.Color
  spoke : @graphics.Color
  hub : @graphics.Color
  frame : @graphics.Color
  frame_dark : @graphics.Color
  cream : @graphics.Color
  cream_shade : @graphics.Color
  cream_edge : @graphics.Color
  leg_near : @graphics.Color
  leg_far : @graphics.Color
  beak : @graphics.Color
  beak_dark : @graphics.Color
  pouch : @graphics.Color
  pouch_edge : @graphics.Color
  cap : @graphics.Color
  cap_dark : @graphics.Color
  scarf : @graphics.Color
  scarf_alt : @graphics.Color
  eye : @graphics.Color
  eye_white : @graphics.Color
  shadow : @graphics.Color
}

///|
fn color(r : Int32, g : Int32, b : Int32, a? : Double = 1.0) -> @graphics.Color {
  @graphics.Color::rgba(
    r=r.to_double() / 255.0,
    g=g.to_double() / 255.0,
    b=b.to_double() / 255.0,
    a~,
  )
}

///|
fn palette() -> Palette {
  {
    sky_deep: color(30, 36, 64),
    sky_dusk: color(112, 77, 116),
    sky_rose: color(214, 113, 109),
    sky_warm: color(247, 193, 122),
    sun_core: color(255, 248, 214),
    sun_edge: color(255, 176, 92),
    cloud: color(248, 201, 172),
    hill_far: color(92, 76, 108),
    hill_near: color(64, 54, 82),
    tree: color(48, 42, 66),
    road_top: color(62, 54, 80),
    road_bottom: color(34, 31, 46),
    road_edge: color(238, 190, 122),
    dash: color(244, 211, 159, a=0.85),
    grass: color(38, 34, 52),
    tire: color(28, 27, 36),
    rim: color(247, 214, 156),
    spoke: color(247, 214, 156, a=0.55),
    hub: color(255, 236, 190),
    frame: color(42, 157, 143),
    frame_dark: color(25, 104, 99),
    cream: color(255, 246, 230),
    cream_shade: color(238, 221, 196),
    cream_edge: color(206, 182, 148),
    leg_near: color(238, 159, 92),
    leg_far: color(197, 124, 70),
    beak: color(244, 162, 89),
    beak_dark: color(205, 118, 56),
    pouch: color(238, 138, 86),
    pouch_edge: color(190, 98, 54),
    cap: color(233, 111, 81),
    cap_dark: color(182, 70, 50),
    scarf: color(238, 111, 81),
    scarf_alt: color(247, 196, 120),
    eye: color(44, 36, 38),
    eye_white: color(255, 252, 245),
    shadow: color(20, 16, 28, a=0.30),
  }
}

///|
pub struct Model {
  /// Scene playback multiplier; 1.0 is the tuned riding pace.
  speed : Double
}

///|
pub fn Model::new() -> Model {
  { speed: 1.0, }
}

///|
fn pt(x : Double, y : Double) -> @geometry.Point {
  @geometry.Point::new(x~, y~)
}

///|
fn rect(x : Double, y : Double, width : Double, height : Double) -> @geometry.Rect {
  @geometry.Rect::new(x~, y~, width~, height~)
}

///|
fn wrap(value : Double, period : Double) -> Double {
  value - @math.floor(value / period) * period
}

///|
fn clamp(value : Double, low : Double, high : Double) -> Double {
  if value < low {
    low
  } else if value > high {
    high
  } else {
    value
  }
}

///|
fn rotate_around(
  x : Double,
  y : Double,
  cx : Double,
  cy : Double,
  angle : Double,
) -> @geometry.Point {
  let c = @math.cos(angle)
  let s = @math.sin(angle)
  let dx = x - cx
  let dy = y - cy
  pt(cx + dx * c - dy * s, cy + dx * s + dy * c)
}

///|
/// Filled rounded quad. A radius of half the short side makes this a circle, so
/// arcs are drawn without tessellating a path: the browser renderer copies every
/// path to JavaScript one character at a time, which costs about as much for a
/// dot as for a wheel once the path is flattened into triangles.
fn fill_rounded(
  ctx : @views.PaintContext,
  area : @geometry.Rect,
  radius : Double,
  fill : @graphics.Color,
) -> Unit {
  fill_rounded_rect(
    ctx,
    @graphics.RoundedRect::new(rect=area, radius~),
    @graphics.Brush::solid(fill),
  )
}

///|
fn stroke_rounded(
  ctx : @views.PaintContext,
  area : @geometry.Rect,
  radius : Double,
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  stroke_rounded_rect(
    ctx,
    @graphics.RoundedRect::new(rect=area, radius~),
    @graphics.Brush::solid(stroke),
    width,
  )
}

///|
/// Ellipse outline as polygon chords, used where a scaled quad would distort the
/// edge (very flat ellipses) or where the edge width matters. The chord count
/// follows the radius, so small shapes stay cheap.
fn ellipse_verbs(
  cx : Double,
  cy : Double,
  rx : Double,
  ry : Double,
  rotation : Double,
) -> Array[@graphics.PathVerb] {
  let long = rx.max(ry)
  let raw = (long * 0.7).to_int()
  let segments = if raw < 12 {
    12
  } else if raw > 48 {
    48
  } else {
    raw
  }
  let verbs : Array[@graphics.PathVerb] = []
  let mut index = 0
  while index < segments {
    let angle = index.to_double() / segments.to_double() * 6.283185307179586
    let point = rotate_around(
      cx + @math.cos(angle) * rx,
      cy + @math.sin(angle) * ry,
      cx,
      cy,
      rotation,
    )
    if index == 0 {
      verbs.push(MoveTo(point))
    } else {
      verbs.push(LineTo(point))
    }
    index = index + 1
  }
  verbs.push(Close)
  verbs
}

///|
fn quadratic_point(
  from : @geometry.Point,
  control : @geometry.Point,
  to : @geometry.Point,
  t : Double,
) -> @geometry.Point {
  let u = 1.0 - t
  pt(
    u * u * from.x + 2.0 * u * t * control.x + t * t * to.x,
    u * u * from.y + 2.0 * u * t * control.y + t * t * to.y,
  )
}

///|
fn cubic_point(
  from : @geometry.Point,
  c1 : @geometry.Point,
  c2 : @geometry.Point,
  to : @geometry.Point,
  t : Double,
) -> @geometry.Point {
  let u = 1.0 - t
  let uu = u * u
  let tt = t * t
  pt(
    uu * u * from.x +
    3.0 * uu * t * c1.x +
    3.0 * u * tt * c2.x +
    tt * t * to.x,
    uu * u * from.y +
    3.0 * uu * t * c1.y +
    3.0 * u * tt * c2.y +
    tt * t * to.y,
  )
}

///|
/// One straight segment as a rotated capsule: local x runs along the segment, so
/// the quad stays axis aligned and only the transform carries the slope.
fn stroke_segment(
  ctx : @views.PaintContext,
  from : @geometry.Point,
  to : @geometry.Point,
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  let dx = to.x - from.x
  let dy = to.y - from.y
  let length = (dx * dx + dy * dy).sqrt()
  if length <= 0.0001 || width <= 0.0 {
    return
  }
  let half = width / 2.0
  let angle = @math.atan2(dy, dx)
  let cosine = @math.cos(angle)
  let sine = @math.sin(angle)
  push_transform(
    ctx,
    @graphics.Transform2D::{
      a: cosine,
      b: sine,
      c: 0.0 - sine,
      d: cosine,
      tx: from.x,
      ty: from.y,
    },
  )
  fill_rounded(ctx, rect(0.0 - half, 0.0 - half, length + width, width), half, stroke)
  pop_transform(ctx)
}

///|
fn fill_path(
  ctx : @views.PaintContext,
  verbs : Array[@graphics.PathVerb],
  fill : @graphics.Color,
) -> Unit {
  draw_path(
    ctx,
    @graphics.PathSpec::new(
      verbs=verbs,
      fill=Some(@graphics.Brush::solid(fill)),
    ),
  )
}

///|
/// Strokes are flattened here and emitted as capsule quads. Translucent strokes
/// keep the vector path so overlapping capsules do not darken every joint.
fn stroke_path(
  ctx : @views.PaintContext,
  verbs : Array[@graphics.PathVerb],
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  if stroke.a < 0.999 {
    draw_path(
      ctx,
      @graphics.PathSpec::new(
        verbs=verbs,
        stroke=Some(@graphics.Brush::solid(stroke)),
        stroke_width=width,
      ),
    )
    return
  }
  let mut current = pt(0.0, 0.0)
  let mut start = current
  for verb in verbs {
    match verb {
      MoveTo(point) => {
        current = point
        start = point
      }
      LineTo(point) => {
        stroke_segment(ctx, current, point, stroke, width)
        current = point
      }
      QuadTo(control, point) => {
        let from = current
        let mut step = 1
        while step <= 6 {
          let next = quadratic_point(from, control, point, step.to_double() / 6.0)
          stroke_segment(ctx, current, next, stroke, width)
          current = next
          step = step + 1
        }
      }
      CubicTo(c1, c2, point) => {
        let from = current
        let mut step = 1
        while step <= 8 {
          let next = cubic_point(from, c1, c2, point, step.to_double() / 8.0)
          stroke_segment(ctx, current, next, stroke, width)
          current = next
          step = step + 1
        }
      }
      Close => {
        stroke_segment(ctx, current, start, stroke, width)
        current = start
      }
    }
  }
}

///|
fn fill_path_outlined(
  ctx : @views.PaintContext,
  verbs : Array[@graphics.PathVerb],
  fill : @graphics.Color,
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  fill_path(ctx, verbs, fill)
  stroke_path(ctx, verbs, stroke, width)
}

///|
fn fill_ellipse(
  ctx : @views.PaintContext,
  cx : Double,
  cy : Double,
  rx : Double,
  ry : Double,
  rotation : Double,
  fill : @graphics.Color,
) -> Unit {
  let long = rx.max(ry)
  let short = rx.min(ry)
  if short <= 0.0 {
    return
  }
  if rotation == 0.0 && (long - short).abs() <= 0.0001 {
    fill_rounded(ctx, rect(cx - rx, cy - ry, rx * 2.0, ry * 2.0), short, fill)
    return
  }
  if long / short <= 1.8 {
    // A circle scaled in local space stays one analytic quad; the edge softness
    // scales with the quad, so keep this to near-circular ellipses.
    let cosine = @math.cos(rotation)
    let sine = @math.sin(rotation)
    let scale_x = rx / long
    let scale_y = ry / long
    push_transform(
      ctx,
      @graphics.Transform2D::{
        a: scale_x * cosine,
        b: scale_x * sine,
        c: 0.0 - scale_y * sine,
        d: scale_y * cosine,
        tx: cx,
        ty: cy,
      },
    )
    fill_rounded(
      ctx,
      rect(0.0 - long, 0.0 - long, long * 2.0, long * 2.0),
      long,
      fill,
    )
    pop_transform(ctx)
    return
  }
  fill_path(ctx, ellipse_verbs(cx, cy, rx, ry, rotation), fill)
}

///|
fn stroke_ellipse(
  ctx : @views.PaintContext,
  cx : Double,
  cy : Double,
  rx : Double,
  ry : Double,
  rotation : Double,
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  if rotation == 0.0 && (rx - ry).abs() <= 0.0001 {
    stroke_rounded(
      ctx,
      rect(cx - rx, cy - ry, rx * 2.0, ry * 2.0),
      rx,
      stroke,
      width,
    )
    return
  }
  stroke_path(ctx, ellipse_verbs(cx, cy, rx, ry, rotation), stroke, width)
}

///|
fn fill_circle(
  ctx : @views.PaintContext,
  center : @geometry.Point,
  radius : Double,
  fill : @graphics.Color,
) -> Unit {
  if radius <= 0.0 {
    return
  }
  fill_rounded(
    ctx,
    rect(center.x - radius, center.y - radius, radius * 2.0, radius * 2.0),
    radius,
    fill,
  )
}

///|
fn stroke_circle(
  ctx : @views.PaintContext,
  center : @geometry.Point,
  radius : Double,
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  if radius <= 0.0 {
    return
  }
  stroke_rounded(
    ctx,
    rect(center.x - radius, center.y - radius, radius * 2.0, radius * 2.0),
    radius,
    stroke,
    width,
  )
}

///|
fn stroke_line(
  ctx : @views.PaintContext,
  from : @geometry.Point,
  to : @geometry.Point,
  stroke : @graphics.Color,
  width : Double,
) -> Unit {
  if stroke.a < 0.999 {
    draw_path(
      ctx,
      @graphics.PathSpec::new(
        verbs=[MoveTo(from), LineTo(to)],
        stroke=Some(@graphics.Brush::solid(stroke)),
        stroke_width=width,
      ),
    )
    return
  }
  stroke_segment(ctx, from, to, stroke, width)
}

///|
fn fill_gradient_rect(
  ctx : @views.PaintContext,
  area : @geometry.Rect,
  start : @geometry.Point,
  end : @geometry.Point,
  start_color : @graphics.Color,
  end_color : @graphics.Color,
) -> Unit {
  fill_rounded_rect(
    ctx,
    @graphics.RoundedRect::new(rect=area),
    @graphics.Brush::linear_gradient(
      start~,
      end~,
      start_color~,
      end_color~,
    ),
  )
}

///|
fn pedal_point(
  crank : @geometry.Point,
  angle : Double,
  arm : Double,
) -> @geometry.Point {
  pt(crank.x + @math.cos(angle) * arm, crank.y + @math.sin(angle) * arm)
}

///|
/// Two-bone IK with the knee pushed forward (+x). Returned point always sits at
/// `upper` from the hip; `lower` from the foot is guaranteed while the target is
/// within reach, which the pedal orbit is sized for.
fn knee_point(
  hip : @geometry.Point,
  foot : @geometry.Point,
  upper : Double,
  lower : Double,
) -> @geometry.Point {
  let dx = foot.x - hip.x
  let dy = foot.y - hip.y
  let raw = (dx * dx + dy * dy).sqrt()
  let reach = clamp(raw, 2.0, upper + lower - 0.5)
  let ux = if raw > 0.0001 { dx / raw } else { 1.0 }
  let uy = if raw > 0.0001 { dy / raw } else { 0.0 }
  let along = (upper * upper - lower * lower + reach * reach) / (2.0 * reach)
  let height_sq = upper * upper - along * along
  let height = if height_sq > 0.0 { height_sq.sqrt() } else { 0.0 }
  let base = pt(hip.x + ux * along, hip.y + uy * along)
  let nx = 0.0 - uy
  let ny = ux
  let facing = if nx < 0.0 { 0.0 - 1.0 } else { 1.0 }
  pt(base.x + nx * height * facing, base.y + ny * height * facing)
}

///|
fn blink_amount(t : Double) -> Double {
  let phase = wrap(t, 4.4)
  clamp(1.0 - (phase - 4.1).abs() / 0.18, 0.0, 1.0)
}

///|
fn hill_verbs(
  offset : Double,
  base_y : Double,
  amplitude : Double,
) -> Array[@graphics.PathVerb] {
  let height_at = fn(x : Double) -> Double {
    base_y +
    @math.sin((x + offset) * 0.007) * amplitude +
    @math.sin((x + offset) * 0.017 + 1.3) * amplitude * 0.45
  }
  let verbs : Array[@graphics.PathVerb] = [
    MoveTo(pt(-80.0, 700.0)),
    LineTo(pt(-80.0, height_at(-80.0))),
  ]
  let mut x = -40.0
  while x <= 1080.0 {
    verbs.push(LineTo(pt(x, height_at(x))))
    x = x + 40.0
  }
  verbs.push(LineTo(pt(1080.0, 700.0)))
  verbs.push(Close)
  verbs
}

///|
fn paint_sky(ctx : @views.PaintContext, p : Palette) -> Unit {
  fill_gradient_rect(
    ctx,
    rect(-10.0, -10.0, stage_width + 20.0, 260.0),
    pt(0.0, 0.0),
    pt(0.0, 240.0),
    p.sky_deep,
    p.sky_dusk,
  )
  fill_gradient_rect(
    ctx,
    rect(-10.0, 240.0, stage_width + 20.0, 160.0),
    pt(0.0, 240.0),
    pt(0.0, 400.0),
    p.sky_dusk,
    p.sky_rose,
  )
  fill_gradient_rect(
    ctx,
    rect(-10.0, 400.0, stage_width + 20.0, 140.0),
    pt(0.0, 400.0),
    pt(0.0, 540.0),
    p.sky_rose,
    p.sky_warm,
  )
}

///|
fn paint_stars(ctx : @views.PaintContext, t : Double) -> Unit {
  let mut i = 0
  while i < 8 {
    let index = i.to_double()
    let x = 70.0 + index * 116.0 + (i % 3).to_double() * 23.0
    let y = 38.0 + (i % 4).to_double() * 27.0
    let glow = 0.5 + 0.5 * @math.sin(t * 1.7 + index * 1.9)
    let radius = 1.4 + (i % 2).to_double() * 0.9
    fill_circle(ctx, pt(x, y), radius, color(255, 244, 214, a=0.25 + 0.5 * glow))
    i = i + 1
  }
}

///|
fn paint_sun(ctx : @views.PaintContext, p : Palette) -> Unit {
  let center = pt(804.0, 404.0)
  let radius = 72.0
  fill_circle(ctx, center, radius + 46.0, color(255, 190, 110, a=0.05))
  fill_circle(ctx, center, radius + 24.0, color(255, 196, 120, a=0.08))
  fill_rounded_rect(
    ctx,
    @graphics.RoundedRect::new(
      rect=rect(center.x - radius, center.y - radius, radius * 2.0, radius * 2.0),
      radius~,
    ),
    @graphics.Brush::radial_gradient(
      center~,
      radius~,
      center_color=p.sun_core,
      edge_color=p.sun_edge,
    ),
  )
}

///|
fn paint_cloud(
  ctx : @views.PaintContext,
  p : Palette,
  x : Double,
  y : Double,
  scale : Double,
  opacity : Double,
) -> Unit {
  push_opacity(ctx, opacity)
  fill_ellipse(ctx, x, y, 54.0 * scale, 16.0 * scale, 0.0, p.cloud)
  fill_ellipse(ctx, x - 40.0 * scale, y + 4.0 * scale, 30.0 * scale, 12.0 * scale, 0.0, p.cloud)
  fill_ellipse(ctx, x + 42.0 * scale, y + 2.0 * scale, 36.0 * scale, 13.0 * scale, 0.0, p.cloud)
  fill_ellipse(ctx, x + 6.0 * scale, y - 9.0 * scale, 26.0 * scale, 14.0 * scale, 0.0, p.cloud)
  pop_opacity(ctx)
}

///|
fn paint_clouds(ctx : @views.PaintContext, p : Palette, ride : Double) -> Unit {
  paint_cloud(ctx, p, wrap(120.0 + ride * 9.0, 1400.0) - 200.0, 152.0, 1.0, 0.55)
  paint_cloud(ctx, p, wrap(560.0 + ride * 6.0, 1400.0) - 200.0, 106.0, 0.72, 0.42)
  paint_cloud(ctx, p, wrap(900.0 + ride * 11.0, 1400.0) - 200.0, 220.0, 1.15, 0.5)
}

///|
fn paint_tree(ctx : @views.PaintContext, p : Palette, x : Double) -> Unit {
  let verbs : Array[@graphics.PathVerb] = [
    MoveTo(pt(x, 524.0)),
    CubicTo(pt(x - 19.0, 484.0), pt(x - 14.0, 442.0), pt(x, 410.0)),
    CubicTo(pt(x + 14.0, 442.0), pt(x + 19.0, 484.0), pt(x, 524.0)),
    Close,
  ]
  fill_path(ctx, verbs, p.tree)
}

///|
fn paint_hills(ctx : @views.PaintContext, p : Palette, ride : Double) -> Unit {
  fill_path(ctx, hill_verbs(ride * 14.0, 472.0, 18.0), p.hill_far)
  let mut i = 0
  while i < 4 {
    let x = wrap(80.0 + i.to_double() * 290.0 + ride * 20.0, 1180.0) - 90.0
    paint_tree(ctx, p, x)
    i = i + 1
  }
  fill_path(ctx, hill_verbs(ride * 26.0 + 300.0, 500.0, 12.0), p.hill_near)
}

///|
fn paint_road(ctx : @views.PaintContext, p : Palette, ride : Double) -> Unit {
  fill_gradient_rect(
    ctx,
    rect(-10.0, 520.0, stage_width + 20.0, 130.0),
    pt(0.0, 520.0),
    pt(0.0, 640.0),
    p.road_top,
    p.road_bottom,
  )
  fill_rect(ctx, rect(0.0, 519.0, stage_width, 3.0), p.road_edge)
  let offset = wrap(ride * 260.0, 96.0)
  let mut x = 0.0 - 96.0 - offset
  while x < stage_width {
    fill_rounded_rect(
      ctx,
      @graphics.RoundedRect::new(rect=rect(x, 574.0, 46.0, 7.0), radius=3.5),
      @graphics.Brush::solid(p.dash),
    )
    x = x + 96.0
  }
}

///|
fn paint_roadside(ctx : @views.PaintContext, p : Palette, ride : Double) -> Unit {
  let mut i = 0
  while i < 9 {
    let x = wrap(i.to_double() * 130.0 + ride * 190.0, 1170.0) - 60.0
    let sway = @math.sin(ride * 1.3 + i.to_double()) * 2.0
    stroke_path(
      ctx,
      [
        MoveTo(pt(x, 524.0)),
        QuadTo(pt(x - 6.0 + sway, 514.0), pt(x - 10.0 + sway, 504.0)),
      ],
      p.grass,
      3.0,
    )
    stroke_path(
      ctx,
      [
        MoveTo(pt(x + 2.0, 524.0)),
        QuadTo(pt(x + 8.0 - sway, 516.0), pt(x + 12.0 - sway, 507.0)),
      ],
      p.grass,
      2.5,
    )
    i = i + 1
  }
}

///|
fn paint_foreground_grass(
  ctx : @views.PaintContext,
  p : Palette,
  ride : Double,
) -> Unit {
  let mut i = 0
  while i < 14 {
    let x = wrap(i.to_double() * 84.0 + ride * 300.0, 1180.0) - 70.0
    let sway = @math.sin(ride * 2.1 + i.to_double() * 0.8) * 4.0
    stroke_path(
      ctx,
      [
        MoveTo(pt(x, 650.0)),
        QuadTo(pt(x - 8.0 + sway, 628.0), pt(x - 16.0 + sway, 606.0)),
      ],
      p.grass,
      5.0,
    )
    stroke_path(
      ctx,
      [
        MoveTo(pt(x + 5.0, 650.0)),
        QuadTo(pt(x + 3.0 - sway, 626.0), pt(x + 12.0 - sway, 612.0)),
      ],
      p.grass,
      3.5,
    )
    i = i + 1
  }
}

///|
fn paint_ground_shadow(ctx : @views.PaintContext, p : Palette) -> Unit {
  fill_ellipse(ctx, 515.0, 558.0, 244.0, 12.0, 0.0, p.shadow)
  fill_ellipse(ctx, rear_hub_x, 558.0, 62.0, 4.0, 0.0, color(20, 16, 28, a=0.35))
  fill_ellipse(ctx, front_hub_x, 558.0, 62.0, 4.0, 0.0, color(20, 16, 28, a=0.35))
}

///|
fn paint_dust(ctx : @views.PaintContext, ride : Double) -> Unit {
  let mut i = 0
  while i < 3 {
    let phase = wrap(ride * 1.4 + i.to_double() * 0.37, 1.0)
    let x = rear_hub_x - 20.0 - phase * 130.0
    let y = 540.0 - phase * 42.0
    let radius = 7.0 + phase * 13.0
    let alpha = (1.0 - phase) * 0.22
    fill_circle(ctx, pt(x, y), radius, color(255, 236, 210, a=alpha))
    i = i + 1
  }
}

///|
fn paint_wheel(
  ctx : @views.PaintContext,
  p : Palette,
  center : @geometry.Point,
  angle : Double,
) -> Unit {
  stroke_circle(ctx, center, wheel_radius - 6.0, p.tire, 13.0)
  stroke_circle(ctx, center, wheel_radius - 17.0, p.rim, 4.0)
  let mut spoke = 0
  while spoke < 8 {
    let a = angle + spoke.to_double() * 0.7853981633974483
    let inner = pt(center.x + @math.cos(a) * 9.0, center.y + @math.sin(a) * 9.0)
    let outer = pt(
      center.x + @math.cos(a) * (wheel_radius - 20.0),
      center.y + @math.sin(a) * (wheel_radius - 20.0),
    )
    stroke_line(ctx, inner, outer, p.spoke, 1.6)
    spoke = spoke + 1
  }
  fill_circle(
    ctx,
    pt(center.x + @math.cos(angle + 0.5) * 56.0, center.y + @math.sin(angle + 0.5) * 56.0),
    2.6,
    p.rim,
  )
  fill_circle(ctx, center, 7.5, p.hub)
  stroke_circle(ctx, center, 7.5, p.tire, 2.0)
}

///|
fn paint_crank(
  ctx : @views.PaintContext,
  p : Palette,
  crank : @geometry.Point,
  angle : Double,
  near : Bool,
) -> Unit {
  let pedal = pedal_point(crank, angle, pedal_arm)
  let arm_color = if near { p.frame } else { p.frame_dark }
  stroke_line(ctx, crank, pedal, arm_color, 7.0)
  fill_rounded_rect(
    ctx,
    @graphics.RoundedRect::new(
      rect=rect(pedal.x - 13.0, pedal.y - 5.0, 26.0, 10.0),
      radius=5.0,
    ),
    @graphics.Brush::solid(p.tire),
  )
  fill_rounded_rect(
    ctx,
    @graphics.RoundedRect::new(
      rect=rect(pedal.x - 13.0, pedal.y - 5.0, 26.0, 3.5),
      radius=2.0,
    ),
    @graphics.Brush::solid(if near { p.rim } else { p.spoke }),
  )
}

///|
fn paint_handlebar(ctx : @views.PaintContext, p : Palette) -> Unit {
  let head_top = pt(620.0, 356.0)
  let stem_top = pt(644.0, 340.0)
  stroke_line(ctx, head_top, stem_top, p.frame, 9.0)
  fill_circle(ctx, head_top, 5.5, p.frame)
  stroke_line(ctx, stem_top, pt(668.0, 338.0), p.tire, 10.0)
  fill_circle(ctx, pt(668.0, 338.0), 5.0, p.tire)
  fill_circle(ctx, pt(660.0, 329.0), 5.5, p.rim)
  stroke_circle(ctx, pt(660.0, 329.0), 5.5, p.tire, 1.5)
}

///|
fn paint_bike(ctx : @views.PaintContext, p : Palette) -> Unit {
  let rear = pt(rear_hub_x, hub_y)
  let front = pt(front_hub_x, hub_y)
  let crank = pt(crank_x, hub_y)
  let seat_top = pt(438.0, 362.0)
  let head_top = pt(620.0, 356.0)
  stroke_path(
    ctx,
    [MoveTo(rear), LineTo(pt(330.0, 466.0)), LineTo(pt(330.0, 490.0)), LineTo(rear)],
    p.rim,
    2.0,
  )
  stroke_line(ctx, pt(crank_x, 455.0), pt(330.0, 466.0), color(247, 214, 156, a=0.65), 2.2)
  stroke_line(ctx, pt(crank_x, 501.0), pt(330.0, 490.0), color(247, 214, 156, a=0.65), 2.2)
  stroke_circle(ctx, rear, 12.0, p.rim, 4.0)
  stroke_line(ctx, rear, crank, p.frame, 11.0)
  stroke_line(ctx, crank, seat_top, p.frame, 12.0)
  stroke_line(ctx, seat_top, head_top, p.frame, 10.0)
  stroke_line(ctx, crank, head_top, p.frame, 12.0)
  stroke_line(ctx, seat_top, rear, p.frame, 7.0)
  stroke_line(ctx, head_top, front, p.frame_dark, 10.0)
  fill_circle(ctx, rear, 6.0, p.frame)
  fill_circle(ctx, crank, 6.0, p.frame)
  fill_circle(ctx, seat_top, 6.0, p.frame)
  fill_circle(ctx, head_top, 6.0, p.frame)
  stroke_circle(ctx, crank, 23.0, p.rim, 5.0)
  stroke_circle(ctx, crank, 15.0, p.frame_dark, 2.0)
  let mut bolt = 0
  while bolt < 5 {
    let a = bolt.to_double() * 1.2566370614359172
    fill_circle(
      ctx,
      pt(crank.x + @math.cos(a) * 11.0, crank.y + @math.sin(a) * 11.0),
      1.8,
      p.frame_dark,
    )
    bolt = bolt + 1
  }
}

///|
fn hip_point(near : Bool, bob : Double) -> @geometry.Point {
  if near {
    pt(468.0, 378.0 + bob)
  } else {
    pt(448.0, 374.0 + bob)
  }
}

///|
fn paint_leg(
  ctx : @views.PaintContext,
  p : Palette,
  hip : @geometry.Point,
  foot : @geometry.Point,
  near : Bool,
) -> Unit {
  let knee = knee_point(hip, foot, 62.0, 64.0)
  let thigh = if near { p.cream } else { p.cream_shade }
  let shin = if near { p.leg_near } else { p.leg_far }
  let shin_edge = if near { p.beak_dark } else { p.pouch_edge }
  stroke_line(ctx, hip, knee, p.cream_edge, 27.0)
  stroke_line(ctx, hip, knee, thigh, 23.0)
  fill_circle(ctx, knee, 13.0, thigh)
  stroke_circle(ctx, knee, 13.0, p.cream_edge, 2.0)
  stroke_line(ctx, knee, foot, shin_edge, 15.0)
  stroke_line(ctx, knee, foot, shin, 11.0)
  let toe : Array[@graphics.PathVerb] = [
    MoveTo(pt(foot.x - 5.0, foot.y - 4.0)),
    LineTo(pt(foot.x + 19.0, foot.y - 2.0)),
    LineTo(pt(foot.x + 17.0, foot.y + 5.0)),
    LineTo(pt(foot.x + 9.0, foot.y + 8.0)),
    LineTo(pt(foot.x + 4.0, foot.y + 4.0)),
    LineTo(pt(foot.x - 5.0, foot.y + 4.0)),
    Close,
  ]
  fill_path_outlined(ctx, toe, shin, shin_edge, 2.0)
}

///|
fn paint_scarf_ribbons(
  ctx : @views.PaintContext,
  p : Palette,
  ride : Double,
  bob : Double,
) -> Unit {
  let wave = @math.sin(ride * 3.3) * 11.0
  let wave_late = @math.sin(ride * 3.3 + 0.8) * 9.0
  stroke_path(
    ctx,
    [
      MoveTo(pt(528.0, 292.0 + bob)),
      CubicTo(
        pt(480.0, 274.0 + bob + wave * 0.4),
        pt(430.0, 318.0 + bob + wave),
        pt(386.0, 306.0 + bob + wave_late),
      ),
      CubicTo(
        pt(356.0, 298.0 + bob + wave_late),
        pt(340.0, 288.0 + bob + wave),
        pt(318.0, 290.0 + bob + wave),
      ),
    ],
    p.scarf,
    12.0,
  )
  stroke_path(
    ctx,
    [
      MoveTo(pt(532.0, 304.0 + bob)),
      CubicTo(
        pt(492.0, 296.0 + bob - wave * 0.3),
        pt(452.0, 336.0 + bob - wave),
        pt(404.0, 330.0 + bob - wave_late),
      ),
      CubicTo(
        pt(378.0, 326.0 + bob - wave_late),
        pt(360.0, 320.0 + bob - wave),
        pt(336.0, 322.0 + bob - wave),
      ),
    ],
    p.scarf_alt,
    7.0,
  )
}

///|
fn paint_pelican_body(ctx : @views.PaintContext, p : Palette, bob : Double) -> Unit {
  let tail : Array[@graphics.PathVerb] = [
    MoveTo(pt(410.0, 330.0 + bob)),
    CubicTo(
      pt(374.0, 314.0 + bob),
      pt(344.0, 306.0 + bob),
      pt(314.0, 300.0 + bob),
    ),
    LineTo(pt(330.0, 326.0 + bob)),
    LineTo(pt(312.0, 334.0 + bob)),
    CubicTo(
      pt(348.0, 350.0 + bob),
      pt(382.0, 362.0 + bob),
      pt(414.0, 364.0 + bob),
    ),
    Close,
  ]
  fill_path_outlined(ctx, tail, p.cream, p.cream_edge, 3.0)
  fill_ellipse(ctx, 466.0, 318.0 + bob, 82.0, 60.0, -0.12, p.cream)
  fill_ellipse(ctx, 480.0, 338.0 + bob, 55.0, 30.0, -0.08, p.cream_shade)
  stroke_ellipse(ctx, 466.0, 318.0 + bob, 82.0, 60.0, -0.12, p.cream_edge, 3.0)
  stroke_path(
    ctx,
    [
      MoveTo(pt(430.0, 322.0 + bob)),
      QuadTo(pt(444.0, 330.0 + bob), pt(460.0, 326.0 + bob)),
    ],
    p.cream_edge,
    2.0,
  )
  stroke_path(
    ctx,
    [
      MoveTo(pt(444.0, 344.0 + bob)),
      QuadTo(pt(458.0, 352.0 + bob), pt(474.0, 346.0 + bob)),
    ],
    p.cream_edge,
    2.0,
  )
}

///|
fn paint_pelican_head(
  ctx : @views.PaintContext,
  p : Palette,
  ride : Double,
  bob : Double,
  head_lift : Double,
) -> Unit {
  let neck : Array[@graphics.PathVerb] = [
    MoveTo(pt(494.0, 320.0 + bob)),
    CubicTo(
      pt(502.0, 288.0 + bob),
      pt(526.0, 262.0 + head_lift),
      pt(558.0, 252.0 + head_lift),
    ),
  ]
  outline_path_thick(ctx, neck, p.cream_edge, p.cream, 46.0, 40.0)
  let head = pt(570.0, 250.0 + head_lift)
  fill_circle(ctx, head, 34.0, p.cream)
  stroke_circle(ctx, head, 34.0, p.cream_edge, 3.0)
  let bx = head.x
  let by = head.y
  let pouch : Array[@graphics.PathVerb] = [
    MoveTo(pt(bx + 26.0, by + 8.0)),
    CubicTo(
      pt(bx + 40.0, by + 56.0),
      pt(bx + 116.0, by + 72.0),
      pt(bx + 178.0, by + 34.0),
    ),
    LineTo(pt(bx + 188.0, by + 38.0)),
    CubicTo(
      pt(bx + 120.0, by + 86.0),
      pt(bx + 42.0, by + 70.0),
      pt(bx + 20.0, by + 18.0),
    ),
    Close,
  ]
  fill_path_outlined(ctx, pouch, p.pouch, p.pouch_edge, 2.5)
  let bill : Array[@graphics.PathVerb] = [
    MoveTo(pt(bx + 24.0, by - 6.0)),
    CubicTo(
      pt(bx + 80.0, by - 14.0),
      pt(bx + 146.0, by + 2.0),
      pt(bx + 198.0, by + 26.0),
    ),
    LineTo(pt(bx + 191.0, by + 35.0)),
    CubicTo(
      pt(bx + 140.0, by + 18.0),
      pt(bx + 80.0, by + 10.0),
      pt(bx + 24.0, by + 8.0),
    ),
    Close,
  ]
  fill_path_outlined(ctx, bill, p.beak, p.beak_dark, 3.0)
  stroke_path(
    ctx,
    [
      MoveTo(pt(bx + 62.0, by + 7.0)),
      QuadTo(pt(bx + 70.0, by + 5.0), pt(bx + 76.0, by + 2.0)),
    ],
    p.beak_dark,
    2.0,
  )
  let cap : Array[@graphics.PathVerb] = [
    MoveTo(pt(bx - 32.0, by - 8.0)),
    CubicTo(
      pt(bx - 30.0, by - 46.0),
      pt(bx + 12.0, by - 52.0),
      pt(bx + 28.0, by - 16.0),
    ),
    LineTo(pt(bx + 46.0, by - 10.0)),
    CubicTo(
      pt(bx + 36.0, by - 2.0),
      pt(bx + 10.0, by - 2.0),
      pt(bx - 8.0, by - 6.0),
    ),
    Close,
  ]
  fill_path_outlined(ctx, cap, p.cap, p.cap_dark, 2.5)
  stroke_line(ctx, pt(bx - 26.0, by - 16.0), pt(bx + 24.0, by - 22.0), p.cap_dark, 4.0)
  let blink = blink_amount(ride)
  let eye = pt(bx + 20.0, by + 3.0)
  let open = 1.0 - blink
  if open > 0.12 {
    fill_ellipse(ctx, eye.x, eye.y, 8.5, 8.0 * open + 0.5, 0.0, p.eye_white)
    fill_circle(ctx, pt(eye.x + 1.2, eye.y), 4.4 * (0.55 + 0.45 * open), p.eye)
    fill_circle(ctx, pt(eye.x + 2.8, eye.y - 2.0), 1.7, p.eye_white)
  } else {
    stroke_path(
      ctx,
      [
        MoveTo(pt(eye.x - 8.0, eye.y)),
        QuadTo(pt(eye.x, eye.y + 3.0), pt(eye.x + 8.0, eye.y)),
      ],
      p.eye,
      2.0,
    )
  }
  fill_circle(ctx, pt(530.0, 294.0 + bob), 9.0, p.scarf)
  stroke_circle(ctx, pt(530.0, 294.0 + bob), 9.0, p.scarf_alt, 2.0)
}

///|
fn outline_path_thick(
  ctx : @views.PaintContext,
  verbs : Array[@graphics.PathVerb],
  outline : @graphics.Color,
  fill : @graphics.Color,
  outline_width : Double,
  fill_width : Double,
) -> Unit {
  stroke_path(ctx, verbs, outline, outline_width)
  stroke_path(ctx, verbs, fill, fill_width)
}

///|
fn paint_wing(ctx : @views.PaintContext, p : Palette, bob : Double) -> Unit {
  let wing : Array[@graphics.PathVerb] = [
    MoveTo(pt(512.0, 306.0 + bob)),
    CubicTo(
      pt(548.0, 298.0 + bob),
      pt(612.0, 314.0 + bob),
      pt(646.0, 334.0 + bob),
    ),
    LineTo(pt(646.0, 344.0 + bob)),
    CubicTo(
      pt(606.0, 348.0 + bob),
      pt(552.0, 354.0 + bob),
      pt(512.0, 352.0 + bob),
    ),
    CubicTo(
      pt(498.0, 342.0 + bob),
      pt(498.0, 320.0 + bob),
      pt(512.0, 306.0 + bob),
    ),
    Close,
  ]
  fill_path_outlined(ctx, wing, p.cream_shade, p.cream_edge, 2.5)
  stroke_path(
    ctx,
    [
      MoveTo(pt(556.0, 316.0 + bob)),
      CubicTo(
        pt(562.0, 328.0 + bob),
        pt(562.0, 338.0 + bob),
        pt(558.0, 348.0 + bob),
      ),
    ],
    p.cream_edge,
    2.0,
  )
  stroke_path(
    ctx,
    [
      MoveTo(pt(588.0, 320.0 + bob)),
      CubicTo(
        pt(594.0, 330.0 + bob),
        pt(594.0, 340.0 + bob),
        pt(590.0, 346.0 + bob),
      ),
    ],
    p.cream_edge,
    2.0,
  )
  stroke_path(
    ctx,
    [
      MoveTo(pt(616.0, 326.0 + bob)),
      CubicTo(
        pt(622.0, 334.0 + bob),
        pt(622.0, 340.0 + bob),
        pt(618.0, 344.0 + bob),
      ),
    ],
    p.cream_edge,
    2.0,
  )
}

///|
fn paint_scene(
  ctx : @views.PaintContext,
  frame : @geometry.Rect,
  now_ms : Double,
  speed : Double,
) -> Unit {
  let t = now_ms / 1000.0
  let ride = t * speed
  let p = palette()
  fill_rect(ctx, frame, p.road_bottom)
  let scale = (frame.size.width / stage_width).max(
    frame.size.height / stage_height,
  )
  if scale <= 0.0 {
    return
  }
  let offset_x = frame.origin.x + (frame.size.width - stage_width * scale) / 2.0
  let offset_y = frame.origin.y + (frame.size.height - stage_height * scale) / 2.0
  push_clip(ctx, frame)
  push_transform(
    ctx,
    @graphics.Transform2D::{
      a: scale,
      b: 0.0,
      c: 0.0,
      d: scale,
      tx: offset_x,
      ty: offset_y,
    },
  )
  paint_sky(ctx, p)
  paint_stars(ctx, t)
  paint_sun(ctx, p)
  paint_clouds(ctx, p, ride)
  paint_hills(ctx, p, ride)
  paint_road(ctx, p, ride)
  paint_roadside(ctx, p, ride)
  paint_ground_shadow(ctx, p)
  let crank = pt(crank_x, hub_y)
  let crank_angle = ride * 3.0
  let wheel_angle = crank_angle * 2.6
  let bob = @math.sin(ride * 5.6) * 1.6
  let head_lift = bob + @math.sin(ride * 5.6 + 0.7) * 1.3
  let far_pedal = pedal_point(crank, crank_angle + @math.PI, pedal_arm)
  let near_pedal = pedal_point(crank, crank_angle, pedal_arm)
  paint_dust(ctx, ride)
  paint_wheel(ctx, p, pt(rear_hub_x, hub_y), wheel_angle)
  paint_wheel(ctx, p, pt(front_hub_x, hub_y), wheel_angle)
  paint_crank(ctx, p, crank, crank_angle + @math.PI, false)
  paint_leg(ctx, p, hip_point(false, bob), far_pedal, false)
  paint_bike(ctx, p)
  paint_crank(ctx, p, crank, crank_angle, true)
  paint_scarf_ribbons(ctx, p, ride, bob)
  paint_pelican_body(ctx, p, bob)
  paint_handlebar(ctx, p)
  paint_wing(ctx, p, bob)
  paint_pelican_head(ctx, p, ride, bob, head_lift)
  paint_leg(ctx, p, hip_point(true, bob), near_pedal, true)
  paint_foreground_grass(ctx, p, ride)
  pop_transform(ctx)
  pop_clip(ctx)
}

///|
fn scene_size(constraints : @geometry.Constraints) -> @geometry.Size {
  constraints.max
}

///|
pub fn view(model : Model) -> @moui.View[Unit] {
  animated_canvas(
    measure=scene_size,
    draw=(ctx, frame, now_ms) => {
      paint_scene(ctx, frame, now_ms, model.speed)
    },
    semantics_label="A pelican in a cap pedaling a bicycle along a sunset road",
  )
}

///|
pub fn program() -> @moui.Program[Model, Unit] {
  @moui.Program::simple(
    init=Model::new(),
    update=(model, _) => model,
    view~,
  )
}
