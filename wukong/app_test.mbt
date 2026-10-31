///|
test "wukong scene loads with skeleton, clips and skin" {
  let model = @wukong.Model::new()
  assert_true(model.loaded)
  let scene = model.snapshot.scene()
  // 24 bones + character root + ground node
  assert_true(scene.nodes().length() >= 26)
  assert_eq(scene.skins().length(), 1)
  assert_eq(scene.animations().length(), 5)
  let clips = scene.animations()
  let names = clips.map(clip => clip.name())
  assert_eq(names, ["idle", "walk", "run", "jump", "attack"])
  assert_true(clips[1].duration() > 0.0)
  // The character root carries the skin and its mesh has joint weights.
  let root = scene.nodes()[model.character_node]
  assert_true(root.skin() is Some(_))
  let mesh = scene.mesh(root.mesh().unwrap()).unwrap()
  let vertex = mesh.primitives()[0].vertices()[0]
  assert_true(vertex.weights().x() > 0.9)
}

///|
test "advance walks the character forward and animates the clip" {
  let walking = @wukong.update(
    @wukong.Model::new(),
    @wukong.Key("w", true),
  )
  let stepped = @wukong.advance(
    @wukong.advance(walking, 1.0 / 60.0),
    1.0 / 60.0,
  )
  assert_eq(stepped.state, Walk)
  assert_true(stepped.pos_z > 0.0)
  assert_true(stepped.clip_time > 0.0)
  // The published snapshot must carry a different scene revision each tick.
  let initial = @wukong.Model::new()
  assert_true(
    stepped.snapshot.scene_revision() > initial.snapshot.scene_revision(),
  )
}

///|
test "space jumps with gravity and lands back into idle" {
  let jumped = @wukong.update(@wukong.Model::new(), @wukong.Key(" ", true))
  assert_eq(jumped.state, Jump)
  let mut current = jumped
  let mut peak = 0.0
  for _ in 0..<240 {
    current = @wukong.advance(current, 1.0 / 60.0)
    peak = peak.max(current.pos_y)
  }
  assert_true(peak > 0.3)
  assert_eq(current.pos_y, 0.0)
  assert_eq(current.state, Idle)
}

///|
test "attack plays for one clip then returns to idle" {
  let struck = @wukong.update(@wukong.Model::new(), @wukong.Key("j", true))
  assert_eq(struck.state, Attack)
  let mut current = struck
  for _ in 0..<90 {
    current = @wukong.advance(current, 1.0 / 60.0)
  }
  assert_eq(current.state, Idle)
}

///|
test "run is faster than walk and turning changes facing" {
  let walk_model = @wukong.update(@wukong.Model::new(), @wukong.Key("w", true))
  let run_model = @wukong.update(walk_model, @wukong.Key("Shift", true))
  let walked = @wukong.advance(walk_model, 0.5)
  let ran = @wukong.advance(run_model, 0.5)
  assert_true(ran.pos_z > walked.pos_z)
  let turned = @wukong.advance(
    @wukong.update(@wukong.Model::new(), @wukong.Key("a", true)),
    0.5,
  )
  assert_true(turned.facing > 0.0)
}

///|
test "pose rebuild never accumulates: same inputs replay identically" {
  let model = @wukong.Model::new()
  let left = @wukong.advance(
    @wukong.update(model, @wukong.Key("w", true)),
    0.3,
  )
  let right = @wukong.advance(
    @wukong.update(model, @wukong.Key("w", true)),
    0.3,
  )
  assert_eq(left.pos_z, right.pos_z)
  assert_eq(left.clip_time, right.clip_time)
}
