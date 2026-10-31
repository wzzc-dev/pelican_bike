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

///|
let walk_speed : Double = 1.4
let run_speed : Double = 3.0
let turn_speed : Double = 2.6
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
  }
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
      let can_jump = space && model.state != Jump && model.pos_y <= 0.001
      let can_attack = strike && model.state != Attack
      if !pressed {
        model
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
    Viewport(_) => model
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
  let moving = forward || back
  // Attack owns the character until its clip finishes; jump ends on landing.
  let (state, clip, clip_time, attack_time) = if model.state == Attack {
    let attack_time = model.attack_time + delta
    if attack_time >= clip_duration(model, clip_attack) {
      (Idle, clip_idle, 0.0, attack_time)
    } else {
      (model.state, model.clip, model.clip_time + delta, attack_time)
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
  // Turning and striding are suppressed mid-swing and mid-air.
  let facing = if state == Attack || state == Jump {
    model.facing
  } else {
    let turn = (if left { 1.0 } else { 0.0 }) - (if right { 1.0 } else { 0.0 })
    model.facing + turn * turn_speed * delta
  }
  let speed = match state {
    Walk => walk_speed
    Run => run_speed
    _ => 0.0
  }
  let (pos_x, pos_z) = if speed <= 0.0 || state == Jump {
    (model.pos_x, model.pos_z)
  } else {
    let sin_f = @math.sin(facing)
    let cos_f = @math.cos(facing)
    let dx = (if forward { sin_f } else { 0.0 }) - (if back { sin_f } else { 0.0 })
    let dz = (if forward { cos_f } else { 0.0 }) - (if back { cos_f } else { 0.0 })
    let length = (dx * dx + dz * dz).sqrt()
    if length > 0.0001 {
      (
        model.pos_x + dx / length * speed * delta,
        model.pos_z + dz / length * speed * delta,
      )
    } else {
      (model.pos_x, model.pos_z)
    }
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
  let animated = model.base_scene.apply_animation_samples(samples)
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
  }
  let hint = if model.loaded {
    "WASD move · Shift run · Space jump · J attack · click the scene to capture the keyboard"
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
