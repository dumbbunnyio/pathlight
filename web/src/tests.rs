//! The page without a browser: Rune's `Runtime` lays it out and takes pointer input, fed the scene `pathlight web` sends
//! (`web/tests/*.json`, written by `scripts/web-fixture.ts`). What the server decides is tested in Bun; these test drawing, input and the fit.

use super::*;
use rune::{Env, Runtime};

fn model(json: &str) -> Arc<Model> {
    Arc::new(Model::parse(json).expect("the fixture parses"))
}

fn parcel() -> Arc<Model> {
    model(include_str!("../tests/parcel.json"))
}

fn frame(view: &str, selected: Option<&str>) -> Frame {
    Frame { view: view.into(), selected: selected.map(str::to_string), ..Frame::default() }
}

fn opened(model: Arc<Model>, view: &str, size: (f32, f32)) -> Runtime<App> {
    let env = Env { system_dark: true, scale: 2.0 };
    let mut app = App::new(model, frame(view, None));
    app.window = "w".into();
    let mut rt = Runtime::new(app, super::view, size, env);
    for _ in 0..5 {
        rt.frame(1.0 / 60.0);
    }
    rt
}

fn boxes_fit(rt: &Runtime<App>, view: &View) {
    let (stage, _) = rt.presented("stage").expect("a stage");
    let boxes: Vec<_> = view.nodes.iter().filter(|n| !n.group).map(|n| (n.id.as_str(), rt.presented(&format!("node/{}", n.id)).expect("each box is drawn").0)).collect();
    for (id, r) in &boxes {
        assert!(r[0] >= stage[0] - 0.5 && r[1] >= stage[1] - 0.5, "{}: {id} starts off the stage: {r:?} in {stage:?}", view.id);
        assert!(r[0] + r[2] <= stage[0] + stage[2] + 0.5 && r[1] + r[3] <= stage[1] + stage[3] + 0.5, "{}: {id} runs off the stage: {r:?} in {stage:?}", view.id);
    }
    for (i, (a, ra)) in boxes.iter().enumerate() {
        for (b, rb) in &boxes[i + 1..] {
            let apart = ra[0] + ra[2] <= rb[0] + 0.01 || rb[0] + rb[2] <= ra[0] + 0.01 || ra[1] + ra[3] <= rb[1] + 0.01 || rb[1] + rb[3] <= ra[1] + 0.01;
            assert!(apart, "{}: {a} overlaps {b}", view.id);
        }
    }
}

#[test]
fn every_box_of_every_view_shows_inside_the_stage_and_none_overlap() {
    let model = parcel();
    for view in &model.views {
        let rt = opened(model.clone(), &view.id, (1440.0, 900.0));
        boxes_fit(&rt, view);
    }
}

#[test]
fn the_largest_reference_view_fits_the_stage_too() {
    // 89 boxes from opencode: step 0's prototype let this view run off the stage.
    let model = model(include_str!("../tests/opencode-largest.json"));
    let view = model.views[0].clone();
    for size in [(1440.0, 900.0), (1100.0, 700.0)] {
        let rt = opened(model.clone(), &view.id, size);
        boxes_fit(&rt, &view);
    }
}

#[test]
fn the_compact_fit_keeps_order_and_nesting() {
    let raw: data::RawModel = serde_json::from_str(include_str!("../tests/parcel.json")).unwrap();
    for (raw, view) in raw.views.iter().zip(parcel().views.iter()) {
        for (a, ra) in raw.nodes.iter().zip(&view.nodes) {
            for (b, rb) in raw.nodes.iter().zip(&view.nodes) {
                if a.rect[0] + a.rect[2] <= b.rect[0] {
                    assert!(ra.rect[0] + ra.rect[2] <= rb.rect[0] + 0.01, "{}: {} was left of {} and is no longer", view.id, a.id, b.id);
                }
                if a.rect[1] + a.rect[3] <= b.rect[1] {
                    assert!(ra.rect[1] + ra.rect[3] <= rb.rect[1] + 0.01, "{}: {} was above {} and is no longer", view.id, a.id, b.id);
                }
                let inside = |p: [f32; 4], q: [f32; 4]| p[0] >= q[0] - 0.01 && p[1] >= q[1] - 0.01 && p[0] + p[2] <= q[0] + q[2] + 0.01 && p[1] + p[3] <= q[1] + q[3] + 0.01;
                if inside(a.rect, b.rect) {
                    assert!(inside(ra.rect, rb.rect), "{}: {} was inside {} and is no longer", view.id, a.id, b.id);
                }
            }
        }
    }
}

#[test]
fn clicking_a_box_selects_it_at_once_and_asks_the_server() {
    let mut rt = opened(parcel(), "services", (1440.0, 900.0));
    let (x, y) = rt.find("node/parcel.commerce.stock").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.selected.as_deref(), Some("parcel.commerce.stock"));
    assert_eq!(rt.state.outbox, vec![Act::Select(Some("parcel.commerce.stock".into()))]);
}

#[test]
fn a_click_on_empty_canvas_clears_the_selection_and_a_drag_only_pans() {
    let mut rt = opened(parcel(), "services", (1440.0, 900.0));
    rt.state.selected = Some("parcel.commerce.api".into());
    let (stage, _) = rt.presented("stage").unwrap();
    let (x, y) = (stage[0] + 6.0, stage[1] + 6.0);
    let before = rt.state.pan;
    rt.pointer_down(x, y);
    rt.pointer_move(x + 40.0, y + 20.0);
    rt.pointer_up(x + 40.0, y + 20.0);
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.selected.as_deref(), Some("parcel.commerce.api"), "a drag keeps the selection");
    assert!((rt.state.pan[0] - before[0] - 40.0).abs() < 0.01, "and pans by what it traveled");
    assert!(rt.state.outbox.is_empty(), "and asks nothing");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.selected, None);
    assert_eq!(rt.state.outbox, vec![Act::Select(None)]);
}

#[test]
fn the_servers_frame_is_the_truth_and_a_new_view_is_fitted() {
    let mut rt = opened(parcel(), "services", (1440.0, 900.0));
    rt.update(|s, _| {
        s.moved = true;
        s.camera([300.0, 200.0], 2.0);
    });
    rt.update(|s, _| s.take("w".into(), frame("checkout", Some("parcel.commerce.inventory"))));
    // Cards that are in both views glide to their new places; let them land.
    for _ in 0..90 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.state.selected.as_deref(), Some("parcel.commerce.inventory"));
    assert!(!rt.state.moved, "a new view starts fitted");
    let view = rt.state.current().unwrap().clone();
    boxes_fit(&rt, &view);
}

#[test]
fn back_puts_back_the_camera_the_view_was_left_with() {
    let mut rt = opened(parcel(), "services", (1440.0, 900.0));
    let mut back = frame("services", Some("parcel.storefront"));
    back.restore = Some(Camera { x: 120.0, y: -40.0, zoom: 1.7, moved: true });
    rt.update(|s, _| s.take("w".into(), frame("checkout", None)));
    rt.frame(1.0 / 60.0);
    rt.update(|s, _| s.take("w".into(), back));
    rt.frame(1.0 / 60.0);
    assert_eq!((rt.state.pan, rt.state.zoom, rt.state.moved), ([120.0, -40.0], 1.7, true));
}

#[test]
fn opening_a_view_sends_the_camera_back_will_need() {
    let mut rt = opened(parcel(), "index", (1440.0, 900.0));
    let opener = rt.state.current().unwrap().nodes.iter().find(|n| n.opens.is_some() && !n.group).cloned().expect("the overview has a box that opens a view");
    let (x, y) = rt.find(&format!("node/{}", opener.id)).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    let camera = Camera { x: rt.state.pan[0], y: rt.state.pan[1], zoom: rt.state.zoom, moved: false };
    assert!(rt.state.outbox.contains(&Act::Open { view: opener.opens.clone().unwrap(), select: None, camera }), "{:?}", rt.state.outbox);
}

#[test]
fn the_views_list_scrolls_when_it_is_longer_than_the_window() {
    let mut views = String::new();
    for i in 0..60 {
        views.push_str(&format!(r#"{}{{"id":"v{i}","title":"View {i}","nodes":[],"edges":[]}}"#, if i > 0 { "," } else { "" }));
    }
    let json = format!(r#"{{"project":"many","palette":{{}},"views":[{views}]}}"#);
    let mut rt = opened(model(&json), "v0", (1440.0, 600.0));
    let (list, _) = rt.presented("rail-scroll").unwrap();
    let last = rt.presented("view/v59").unwrap().0;
    assert!(last[1] > list[1] + list[3], "the last view starts below the fold");
    let (x, y) = (list[0] + 20.0, list[1] + 40.0);
    for _ in 0..40 {
        rt.wheel(x, y, -120.0);
        rt.frame(1.0 / 60.0);
    }
    for _ in 0..60 {
        rt.frame(1.0 / 60.0);
    }
    let last = rt.presented("view/v59").unwrap().0;
    assert!(last[1] + last[3] <= list[1] + list[3] + 1.0, "and scrolling brings it into view: {last:?} in {list:?}");
}

#[test]
fn acts_are_the_json_the_server_reads() {
    assert_eq!(Act::Select(Some("a\"b".into())).json(), r#"{"kind":"select","id":"a\"b"}"#);
    assert_eq!(Act::Back.json(), r#"{"kind":"back"}"#);
    let open = Act::Open { view: "v".into(), select: None, camera: Camera { x: 1.5, y: 2.0, zoom: 0.5, moved: true } };
    assert_eq!(open.json(), r#"{"kind":"open","view":"v","select":null,"camera":{"x":1.5,"y":2,"zoom":0.5,"moved":true}}"#);
}

