///|
/// 3D Sun Wukong playground: a procedurally skinned glTF character that
/// walks, runs, jumps and attacks, rendered through the GPU skinning host
/// port. All motion is driven by the same model update path on native and
/// web; tests call `advance` directly.
using @views { center, card, column, text }

///|
pub(all) enum WukongState {
  Idle
  Walk
  Run
  Jump
  Attack
  Equip
  Stow
} derive(Eq, Debug)

///|
pub extend WukongState with Debug::{to_repr}

///|
pub extend WukongState with Eq::{not_equal, equal}

///|
let clip_idle : Int32 = 0
let clip_walk : Int32 = 1
let clip_run : Int32 = 2
let clip_jump : Int32 = 3
let clip_attack : Int32 = 4
let clip_equip : Int32 = 5
let clip_stow : Int32 = 6

///|
let walk_speed : Double = 1.4
let run_speed : Double = 3.0
let jump_velocity : Double = 4.2
let gravity : Double = 11.0

///|
pub struct Model {
  binding : @moui_3d.ThreeDViewportBinding
  base_scene : @moui_3d.Scene
  snapshot : @moui_3d.ViewportSnapshot
  clips : Array[@moui_3d.AnimationClip]
  character_node : Int32
  state : WukongState
  clip : Int32
  clip_time : Double
  attack_time : Double
  pos_x : Double
  pos_z : Double
  pos_y : Double
  vel_y : Double
  facing : Double
  keys : Array[String]
  elapsed : Double
  ticks : Int64
  loaded : Bool
  dragging : Bool
  drag_x : Double
  drag_y : Double
  drag_moved : Double
  staff_out : Bool
  staff_node : Int32
  staff_hide_node : Int32
}

///|
pub(all) enum Msg {
  Noop
  Tick(Double)
  Key(String, Bool)
  Viewport(@moui_3d.ViewportEvent)
}

///|
pub fn Model::new() -> Model {
  Model::new_with_binding(@moui_3d.ThreeDViewportBinding::new())
}

///|
pub fn Model::new_with_binding(
  binding : @moui_3d.ThreeDViewportBinding,
) -> Model {
  let (scene, character_node, loaded) = load_scene()
  let camera = @moui_3d.OrbitCamera::new(
    target=@moui_3d.Vec3::new(x=0.0, y=1.05, z=0.0),
    radius=3.6,
    azimuth=0.0,
    polar=1.22,
  )
  let snapshot = @moui_3d.ViewportSnapshot::new(
    scene_revision=1L,
    scene~,
    camera~,
  )
  ignore(binding.publish(snapshot))
  {
    binding,
    base_scene: scene,
    snapshot,
    clips: scene.animations(),
    character_node,
    state: Idle,
    clip: clip_idle,
    clip_time: 0.0,
    attack_time: 0.0,
    pos_x: 0.0,
    pos_z: 0.0,
    pos_y: 0.0,
    vel_y: 0.0,
    facing: 0.0,
    keys: [],
    elapsed: 0.0,
    ticks: 0L,
    loaded,
    dragging: false,
    drag_x: 0.0,
    drag_y: 0.0,
    drag_moved: 0.0,
    staff_out: true,
    staff_node: find_node_by_name(scene, "staff_gear"),
    staff_hide_node: find_node_by_name(scene, "staff_hide"),
  }
}

///|
fn find_node_by_name(scene : @moui_3d.Scene, name : String) -> Int32 {
  let mut result = -1
  for index, node in scene.nodes() {
    if node.name() == name {
      result = index
    }
  }
  result
}

///|
/// The generated asset marks the character root as the node that owns the
/// skin; fall back to node zero when the layout ever changes.
fn load_scene() -> (@moui_3d.Scene, Int32, Bool) {
  let scene = @moui_3d.load_gltf_scene(wukong_gltf) catch {
    _ => return (@moui_3d.Scene::empty(), 0, false)
  }
  let nodes = scene.nodes()
  let mut character_node = 0
  for index, node in nodes {
    if node.skin() is Some(_) {
      character_node = index
    }
  }
  (scene, character_node, true)
}

///|
fn Model::pressed(self : Model, key : String) -> Bool {
  self.keys.contains(key)
}

///|
pub fn update(model : Model, message : Msg) -> Model {
  match message {
    Noop => model
    Key(key, pressed) => {
      let keys = if pressed {
        let next = model.keys.copy()
        if !next.contains(key) {
          next.push(key)
        }
        next
      } else {
        model.keys.filter(k => k != key)
      }
      let model = { ..model, keys, }
      let space = key == " " || key == "Space"
      let strike = key == "j" || key == "J"
      let toggle = key == "e" || key == "E"
      let can_jump = space && model.state != Jump && model.pos_y <= 0.001
      let can_attack = strike && model.state != Attack
      let can_toggle = toggle && model.state != Equip && model.state != Stow
      if !pressed {
        model
      } else if can_toggle {
        if model.staff_out {
          { ..model, state: Stow, clip: clip_stow, clip_time: 0.0, staff_out: false }
        } else {
          { ..model, state: Equip, clip: clip_equip, clip_time: 0.0, staff_out: true }
        }
      } else if can_jump {
        {
          ..model,
          vel_y: jump_velocity,
          state: Jump,
          clip: clip_jump,
          clip_time: 0.0,
        }
      } else if can_attack {
        {
          ..model,
          state: Attack,
          clip: clip_attack,
          clip_time: 0.0,
          attack_time: 0.0,
        }
      } else {
        model
      }
    }
    Tick(delta) => advance(model, delta)
    Viewport(event) => match event {
      @moui_3d.PointerDown(point) => {
        {
          ..model,
          dragging: true,
          drag_x: point.x,
          drag_y: point.y,
          drag_moved: 0.0,
        }
      }
      @moui_3d.PointerMove(point) => {
        if model.dragging {
          let dx = point.x - model.drag_x
          let dy = point.y - model.drag_y
          let camera = model.snapshot.camera().orbit(dx * -0.008, dy * -0.008)
          let snapshot = @moui_3d.ViewportSnapshot::new(
            scene_revision=model.snapshot.scene_revision() + 1L,
            scene=model.snapshot.scene(),
            camera~,
          )
          ignore(model.binding.publish(snapshot))
          {
            ..model,
            snapshot,
            drag_x: point.x,
            drag_y: point.y,
            drag_moved: model.drag_moved + dx.abs() + dy.abs(),
          }
        } else {
          model
        }
      }
      @moui_3d.PointerUp(_) => {
        let was_click = model.dragging && model.drag_moved < 6.0
        let model = { ..model, dragging: false, drag_moved: 0.0 }
        if was_click && model.state != Attack {
          {
            ..model,
            state: Attack,
            clip: clip_attack,
            clip_time: 0.0,
            attack_time: 0.0,
          }
        } else {
          model
        }
      }
      @moui_3d.Wheel(amount) => {
        let camera = model.snapshot.camera().zoom(
          if amount > 0.0 { 1.1 } else { 0.9 },
        )
        let snapshot = @moui_3d.ViewportSnapshot::new(
          scene_revision=model.snapshot.scene_revision() + 1L,
          scene=model.snapshot.scene(),
          camera~,
        )
        ignore(model.binding.publish(snapshot))
        { ..model, snapshot, }
      }
      _ => model
    }
  }
}

///|
/// One simulation step: movement, jump physics, clip selection and the
/// per-frame scene rebuild. Kept pure so tests can drive it directly.
pub fn advance(model : Model, delta_input : Double) -> Model {
  let delta = delta_input.min(0.05)
  let forward = model.pressed("w") || model.pressed("W")
  let back = model.pressed("s") || model.pressed("S")
  let left = model.pressed("a") || model.pressed("A")
  let right = model.pressed("d") || model.pressed("D")
  let sprint = model.pressed("Shift")
  let moving = forward || back || left || right
  // Attack owns the character until its clip finishes; jump ends on landing.
  let (state, clip, clip_time, attack_time) = if model.state == Attack {
    let attack_time = model.attack_time + delta
    if attack_time >= clip_duration(model, clip_attack) {
      (Idle, clip_idle, 0.0, attack_time)
    } else {
      (model.state, model.clip, model.clip_time + delta, attack_time)
    }
  } else if model.state == Equip || model.state == Stow {
    if model.clip_time + delta >= clip_duration(model, model.clip) {
      (Idle, clip_idle, 0.0, model.attack_time)
    } else {
      (model.state, model.clip, model.clip_time + delta, model.attack_time)
    }
  } else if model.state == Jump {
    if model.pos_y <= 0.001 && model.vel_y <= 0.0 {
      (Idle, clip_idle, 0.0, model.attack_time)
    } else {
      (model.state, model.clip, model.clip_time + delta, model.attack_time)
    }
  } else if moving {
    let next = if sprint { Run } else { Walk }
    let next_clip = if sprint { clip_run } else { clip_walk }
    if model.state != next {
      (next, next_clip, 0.0, model.attack_time)
    } else {
      (state_of(next), next_clip, model.clip_time + delta, model.attack_time)
    }
  } else if model.state == Walk || model.state == Run {
    (Idle, clip_idle, 0.0, model.attack_time)
  } else {
    (model.state, model.clip, model.clip_time + delta, model.attack_time)
  }
  // Camera-relative locomotion: W/S advance along the view direction and
  // A/D strafe; the character faces its heading. Turning is suppressed
  // mid-swing and mid-air.
  let speed = match state {
    Walk => walk_speed
    Run => run_speed
    _ => 0.0
  }
  let azimuth = model.snapshot.camera().azimuth()
  // camera sits at target + radius*(sin az, ., cos az); forward is toward the
  // target, i.e. (-sin az, -cos az) on the ground plane; right is its perp.
  let fwd_x = -@math.sin(azimuth)
  let fwd_z = -@math.cos(azimuth)
  let right_x = -fwd_z
  let right_z = fwd_x
  let axis_x = (if forward { fwd_x } else { 0.0 }) - (if back { fwd_x } else { 0.0 })
  let axis_z = (if forward { fwd_z } else { 0.0 }) - (if back { fwd_z } else { 0.0 })
  let strafe_x = (if right { right_x } else { 0.0 }) - (if left { right_x } else { 0.0 })
  let strafe_z = (if right { right_z } else { 0.0 }) - (if left { right_z } else { 0.0 })
  let dir_x = axis_x + strafe_x
  let dir_z = axis_z + strafe_z
  let dir_len = (dir_x * dir_x + dir_z * dir_z).sqrt()
  let facing = if state == Attack || state == Jump || state == Equip || state == Stow {
    model.facing
  } else if dir_len > 0.0001 {
    @math.atan2(dir_x, dir_z)
  } else {
    model.facing
  }
  let (pos_x, pos_z) = if speed <= 0.0 || state == Jump || dir_len <= 0.0001 {
    (model.pos_x, model.pos_z)
  } else {
    (
      model.pos_x + dir_x / dir_len * speed * delta,
      model.pos_z + dir_z / dir_len * speed * delta,
    )
  }
  let (pos_y, vel_y) = if model.pos_y > 0.0 || model.vel_y != 0.0 {
    let pos_y = model.pos_y + model.vel_y * delta
    let vel_y = model.vel_y - gravity * delta
    if pos_y <= 0.0 {
      (0.0, 0.0)
    } else {
      (pos_y, vel_y)
    }
  } else {
    (model.pos_y, model.vel_y)
  }
  let looping = state == Idle || state == Walk || state == Run
  let duration = clip_duration(model, clip)
  let clip_time = if duration > 0.0 && looping {
    loop_time(clip_time, duration)
  } else if duration > 0.0 && state == Jump && pos_y > 0.0 {
    // Hold the airborne pose at the last keyframe until landing.
    duration.min(clip_time)
  } else {
    clip_time
  }
  refresh_pose({
    ..model,
    state,
    clip,
    clip_time,
    attack_time,
    facing,
    pos_x,
    pos_z,
    pos_y,
    vel_y,
    elapsed: model.elapsed + delta,
    ticks: model.ticks + 1L,
  })
}

///|
fn state_of(state : WukongState) -> WukongState {
  state
}

///|
fn clip_duration(model : Model, clip : Int32) -> Double {
  match model.clips.get(clip) {
    Some(clip) => clip.duration()
    None => 0.0
  }
}

///|
fn loop_time(value : Double, divisor : Double) -> Double {
  let result = value - (value / divisor).floor() * divisor
  if result < 0.0 { result + divisor } else { result }
}

///|
/// Rebuild the scene from the authored rest pose plus the sampled clip and
/// the procedural root transform, then publish a new snapshot revision.
fn refresh_pose(model : Model) -> Model {
  if !model.loaded {
    return model
  }
  let samples : Array[@moui_3d.AnimationSample] = match model.clips.get(
    model.clip,
  ) {
    None => []
    Some(clip) =>
      clip.channels().map(channel => {
        @moui_3d.AnimationSample::new(
          node=channel.node(),
          path=channel.path(),
          value=@moui_3d.sample_animation_channel(channel, model.clip_time),
        )
      })
  }
  let root = @moui_3d.NodeId::new(model.character_node)
  let yaw = @moui_3d.Quat::from_axis_angle(
    axis=@moui_3d.Vec3::new(x=0.0, y=1.0, z=0.0),
    angle=model.facing,
  )
  samples.push(
    @moui_3d.AnimationSample::new(
      node=root,
      path=@moui_3d.Rotation,
      value=[yaw.x(), yaw.y(), yaw.z(), yaw.w()],
    ),
  )
  samples.push(
    @moui_3d.AnimationSample::new(
      node=root,
      path=@moui_3d.Translation,
      value=[model.pos_x, model.pos_y, model.pos_z],
    ),
  )
  let animated = if model.clip == clip_equip || model.clip == clip_stow {
    model.base_scene.apply_animation_samples(samples)
  } else {
    // Hold the staff at its stowed/equipped size while no gear clip plays:
    // scale 0 hides the rod (kept as a needle by the ear), scale 1 shows it.
    let staff_scale = if model.staff_out { 1.0 } else { 0.0 }
    let with_staff = samples.copy()
    with_staff.push(
      @moui_3d.AnimationSample::new(
        node=@moui_3d.NodeId::new(model.staff_node),
        path=@moui_3d.Scale,
        value=[staff_scale, staff_scale, staff_scale],
      ),
    )
    if model.staff_hide_node >= 0 {
      // Buried rod shells ride the staff_hide bone; it must hold the same
      // scale as the equipment or the ghost rod pops back after the clip.
      with_staff.push(
        @moui_3d.AnimationSample::new(
          node=@moui_3d.NodeId::new(model.staff_hide_node),
          path=@moui_3d.Scale,
          value=[staff_scale, staff_scale, staff_scale],
        ),
      )
    }
    model.base_scene.apply_animation_samples(with_staff)
  }
  let camera = model.snapshot.camera().with_target(
    @moui_3d.Vec3::new(x=model.pos_x, y=1.05, z=model.pos_z),
  )
  let snapshot = @moui_3d.ViewportSnapshot::new(
    scene_revision=model.snapshot.scene_revision() + 1L,
    scene=animated,
    camera~,
  )
  ignore(model.binding.publish(snapshot))
  { ..model, snapshot, }
}

///|
pub fn view(model : Model) -> @moui.View[Msg] {
  let status = match model.binding.status() {
    Loading => "renderer: loading"
    Ready => "renderer: WebGPU ready"
    Unavailable(reason) => "renderer unavailable: \{reason}"
    Failed(reason) => "renderer failed: \{reason}"
  }
  let state_text = match model.state {
    Idle => "idle"
    Walk => "walk"
    Run => "run"
    Jump => "jump"
    Attack => "attack"
    Equip => "equip"
    Stow => "stow"
  }
  let hint = if model.loaded {
    "WASD move · Shift run · Space jump · click attack · drag look · E equip/stow"
  } else {
    "wukong.gltf failed to load; regenerate with scripts/generate-wukong-gltf.mjs"
  }
  center(
    card(
      column([
        text("孙悟空 · 3D Wukong").title(),
        text("\{state_text} · \{status}").caption(),
        focusable_three_d_viewport(
          binding=model.binding,
          snapshot=model.snapshot,
          semantics_label="3D Wukong playground",
          on_event=Some(event => Viewport(event)),
          on_key=Some((key, pressed) => Key(key, pressed)),
        ),
        text(hint).caption(),
      ]),
    ),
  )
}

///|
pub fn program() -> @moui.Program[Model, Msg] {
  @moui.Program::simple(init=Model::new(), update~, view~)
}

///|
pub fn program_with_binding(
  binding : @moui_3d.ThreeDViewportBinding,
  environment~ : @services.AppEnvironment = @services.AppEnvironment::new(),
) -> @moui.Program[Model, Msg] {
  @moui.Program::simple(
    init=Model::new_with_binding(binding),
    update~,
    view~,
    subscriptions=model => {
      if !model.loaded {
        return @moui.Subscription::none()
      }
      match environment.timer() {
        Some(source) =>
          source.subscription(
            interval_ms=16.0,
            key="wukong:simulation",
            label="wukong simulation tick",
            map=frame => Tick(frame.delta_ms / 1000.0),
          )
        None => @moui.Subscription::none()
      }
    },
  )
}
