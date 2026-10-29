///|
test "pedal orbit keeps the crank radius" {
  let crank = pt(505.0, 478.0)
  let mut index = 0
  while index < 8 {
    let angle = index.to_double() * 0.7853981633974483
    let pedal = pedal_point(crank, angle, pedal_arm)
    let dx = pedal.x - crank.x
    let dy = pedal.y - crank.y
    let distance = (dx * dx + dy * dy).sqrt()
    assert_true((distance - pedal_arm).abs() < 0.0001)
    index = index + 1
  }
}

///|
test "two-bone knee preserves both leg segments" {
  let hip = pt(468.0, 378.0)
  let foot = pt(520.0, 470.0)
  let knee = knee_point(hip, foot, 62.0, 64.0)
  let upper_dx = knee.x - hip.x
  let upper_dy = knee.y - hip.y
  let upper = (upper_dx * upper_dx + upper_dy * upper_dy).sqrt()
  let lower_dx = foot.x - knee.x
  let lower_dy = foot.y - knee.y
  let lower = (lower_dx * lower_dx + lower_dy * lower_dy).sqrt()
  assert_true((upper - 62.0).abs() < 0.001)
  assert_true((lower - 64.0).abs() < 0.001)
  assert_true(knee.x > hip.x)
}

///|
test "blink is bounded and periodic" {
  let mut index = 0
  let mut saw_closed = false
  while index < 200 {
    let value = blink_amount(index.to_double() * 0.1)
    assert_true(value >= 0.0 && value <= 1.0)
    if value > 0.9 {
      saw_closed = true
    }
    index = index + 1
  }
  assert_true(saw_closed)
  assert_true(blink_amount(0.0) < 0.001)
  assert_true((blink_amount(4.4) - blink_amount(0.0)).abs() < 0.001)
}
