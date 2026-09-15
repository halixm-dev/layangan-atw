"""
Adu Layangan ATW - Blender asset generator
Jalankan (headless):
  blender -b -P blender/build_assets.py -- <output_dir>
atau lewat:  npm run assets

Semua model dibuat prosedural (low-poly stylized) lalu diekspor ke .glb.
Konvensi orientasi (setelah konversi glTF Y-up):
  - Layangan: hidung ke +Y, muka depan (sisi kekang/benang) ke +Z.
  - Bangunan & karakter: origin di tanah, depan karakter ke +Z.
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, noise

argv = sys.argv
OUT = argv[argv.index("--") + 1] if "--" in argv else os.path.join(os.path.dirname(__file__), "..", "public", "assets")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
_materials = {}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials.clear()


def mat(name, color, rough=0.8, metal=0.0, emit=None):
    if name in _materials:
        return _materials[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:  # Blender < 5 belum otomatis memakai node
        m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if emit is not None:
            try:
                bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
                bsdf.inputs["Emission Strength"].default_value = 1.0
            except KeyError:
                pass
    m.diffuse_color = (*color, 1.0)
    m.use_backface_culling = False
    _materials[name] = m
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def mesh_from_pydata(name, verts, faces, material, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], [], faces)
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(material)
    return link(ob)


def box(name, center, size, material, rot_z=0.0):
    sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    v = [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
         (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    ob = mesh_from_pydata(name, v, f, material)
    ob.location = center
    ob.rotation_euler = (0, 0, rot_z)
    return ob


def cylinder(name, center, radius, depth, material, verts=12, smooth=True, radius_top=None):
    rt = radius if radius_top is None else radius_top
    v, f = [], []
    for i in range(verts):
        a = 2 * math.pi * i / verts
        v.append((math.cos(a) * radius, math.sin(a) * radius, -depth / 2))
    for i in range(verts):
        a = 2 * math.pi * i / verts
        v.append((math.cos(a) * rt, math.sin(a) * rt, depth / 2))
    for i in range(verts):
        j = (i + 1) % verts
        f.append((i, j, verts + j, verts + i))
    f.append(tuple(reversed(range(verts))))
    if rt > 0.0001:
        f.append(tuple(range(verts, 2 * verts)))
    ob = mesh_from_pydata(name, v, f, material)
    if smooth:
        for p in ob.data.polygons[:verts]:
            p.use_smooth = True
    ob.location = center
    return ob


def rod(name, p1, p2, radius, material, verts=6):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    ob = cylinder(name, (p1 + p2) / 2, radius, d.length, material, verts=verts)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = d.normalized().to_track_quat("Z", "Y")
    return ob


def sphere(name, center, radius, material, seg=12, rings=8, scale=(1, 1, 1), hemi=False):
    v, f = [], []
    ring_count = rings // 2 if hemi else rings
    v.append((0, 0, radius))
    for r in range(1, ring_count + (1 if hemi else 0)):
        phi = math.pi * r / rings
        for s in range(seg):
            th = 2 * math.pi * s / seg
            v.append((math.sin(phi) * math.cos(th) * radius, math.sin(phi) * math.sin(th) * radius, math.cos(phi) * radius))
    n_rings = (ring_count if hemi else rings - 1)
    for s in range(seg):
        f.append((0, 1 + s, 1 + (s + 1) % seg))
    for r in range(n_rings - 1):
        for s in range(seg):
            a = 1 + r * seg + s
            b = 1 + r * seg + (s + 1) % seg
            c = 1 + (r + 1) * seg + (s + 1) % seg
            d = 1 + (r + 1) * seg + s
            f.append((a, d, c, b))
    if hemi:
        last = 1 + (n_rings - 1) * seg
        f.append(tuple(reversed(range(last, last + seg))))
    else:
        v.append((0, 0, -radius))
        bottom = len(v) - 1
        last = 1 + (rings - 2) * seg
        for s in range(seg):
            f.append((bottom, last + (s + 1) % seg, last + s))
    ob = mesh_from_pydata(name, v, f, material, smooth=True)
    ob.location = center
    ob.scale = scale
    return ob


def flat_poly(name, pts_xz, material, y=0.0, bow=0.0, thickness=0.0):
    """Poligon datar di bidang XZ (Blender). bow = lengkung ke +Y di ujung sayap."""
    verts = [(x, y + bow * (x * x), z) for (x, z) in pts_xz]
    cx = sum(p[0] for p in pts_xz) / len(pts_xz)
    cz = sum(p[1] for p in pts_xz) / len(pts_xz)
    verts.append((cx, y, cz))
    c = len(verts) - 1
    n = len(pts_xz)
    faces = [(c, (i + 1) % n, i) for i in range(n)]
    return mesh_from_pydata(name, verts, faces, material)


def join_all(name):
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not objs:
        return None
    # bake object transforms into mesh data so the join is exact
    bpy.context.view_layer.update()
    for o in objs:
        mw = o.matrix_world.copy()
        o.data.transform(mw)
        o.matrix_world.identity()
    try:
        with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
            bpy.ops.object.join()
        objs[0].name = name
    except Exception as e:  # noqa
        print("join skipped:", e)
    return objs[0]


def export(filename):
    path = os.path.join(OUT, filename)
    for o in bpy.context.scene.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    print("[ATW] exported", path)


# --------------------------------------------------------------------------
# Palette
# --------------------------------------------------------------------------
def palette():
    return dict(
        sail=mat("Sail", (0.9, 0.9, 0.9), 0.7),
        accent=mat("Accent", (0.08, 0.08, 0.1), 0.6),
        accent2=mat("Accent2", (0.95, 0.78, 0.15), 0.6),
        bamboo=mat("Bamboo", (0.72, 0.56, 0.3), 0.9),
        string=mat("Thread", (0.95, 0.95, 0.9), 0.5),
        tassel=mat("Tassel", (0.95, 0.2, 0.2), 0.8),
    )


# --------------------------------------------------------------------------
# KITES
# --------------------------------------------------------------------------
def kite_speed():
    """Speed Hunter - layangan aduan wajik ramping."""
    reset()
    P = palette()
    top, bottom, wing_z, half_w = 1.05, -0.95, 0.22, 0.62
    outline = [(0, top), (-half_w, wing_z), (0, bottom), (half_w, wing_z)]
    flat_poly("sail", outline, P["sail"], bow=0.18)
    # motif: wajik tengah + garis mata pisau
    flat_poly("accent_core", [(0, 0.55), (-0.25, wing_z), (0, -0.35), (0.25, wing_z)], P["accent"], y=-0.006, bow=0.18)
    flat_poly("accent_tip", [(0, -0.55), (-0.1, -0.72), (0, bottom + 0.02), (0.1, -0.72)], P["accent2"], y=-0.006)
    # rangka
    rod("spine", (0, 0.02, bottom), (0, 0.02, top), 0.012, P["bamboo"])
    n = 8
    for i in range(n):
        x1 = -half_w + 2 * half_w * i / n
        x2 = -half_w + 2 * half_w * (i + 1) / n
        z1 = wing_z + 0.12 * (1 - (x1 / half_w) ** 2)
        z2 = wing_z + 0.12 * (1 - (x2 / half_w) ** 2)
        rod(f"spar{i}", (x1, 0.02 + 0.18 * x1 * x1, z1), (x2, 0.02 + 0.18 * x2 * x2, z2), 0.009, P["bamboo"])
    # kekang (bridle)
    rod("bridle1", (0, 0, 0.55), (0, -0.35, 0.05), 0.003, P["string"], verts=4)
    rod("bridle2", (0, 0, -0.55), (0, -0.35, 0.05), 0.003, P["string"], verts=4)
    join_all("KiteSpeed")
    export("kite_speed.glb")


def kite_heavy():
    """Heavy Brawler - layangan lebar bersegi dengan rangka bambu tebal."""
    reset()
    P = palette()
    outline = [(0, 1.1), (-0.55, 0.75), (-0.85, 0.2), (-0.5, -0.55), (0, -1.0), (0.5, -0.55), (0.85, 0.2), (0.55, 0.75)]
    flat_poly("sail", outline, P["sail"], bow=0.08)
    flat_poly("sail_back", outline, P["accent"], y=0.012, bow=0.08)  # lapisan kedua
    flat_poly("band", [(-0.7, 0.35), (0.7, 0.35), (0.62, 0.05), (-0.62, 0.05)], P["accent2"], y=-0.006, bow=0.08)
    flat_poly("eye", [(0, 0.7), (-0.18, 0.5), (0, 0.3), (0.18, 0.5)], P["accent"], y=-0.008, bow=0.08)
    rod("spine", (0, 0.03, -1.0), (0, 0.03, 1.1), 0.022, P["bamboo"])
    rod("spar", (-0.85, 0.09, 0.2), (0.85, 0.09, 0.2), 0.02, P["bamboo"])
    rod("spar2", (-0.5, 0.05, -0.55), (0.5, 0.05, -0.55), 0.016, P["bamboo"])
    for i in range(len(outline)):
        a, b = outline[i], outline[(i + 1) % len(outline)]
        rod(f"rim{i}", (a[0], 0.08 * a[0] ** 2, a[1]), (b[0], 0.08 * b[0] ** 2, b[1]), 0.012, P["bamboo"])
    # rumbai di ujung sayap
    for sx in (-1, 1):
        for k in range(3):
            rod(f"tassel{sx}{k}", (0.85 * sx, 0.06, 0.2), (0.95 * sx + 0.04 * k * sx, 0.1, -0.15 - 0.08 * k), 0.012, P["tassel"], verts=4)
    rod("bridle1", (0, 0, 0.7), (0, -0.4, 0.05), 0.004, P["string"], verts=4)
    rod("bridle2", (0, 0, -0.6), (0, -0.4, 0.05), 0.004, P["string"], verts=4)
    join_all("KiteHeavy")
    export("kite_heavy.glb")


def kite_acro():
    """Acrobatic Wind - sayap melengkung fleksibel (gaya pecukan)."""
    reset()
    P = palette()
    pts = []
    steps = 10
    # sisi kanan: dari hidung ke ujung sayap melengkung lalu ke ekor
    for i in range(steps + 1):
        t = i / steps
        x = 0.95 * math.sin(t * math.pi / 2)
        z = 0.95 - 0.8 * t - 0.25 * math.sin(t * math.pi) * 0.4
        pts.append((x, z))
    for i in range(1, steps + 1):
        t = i / steps
        x = 0.95 * (1 - t) ** 1.6
        z = 0.15 - 0.95 * t + 0.25 * math.sin(t * math.pi)
        pts.append((x, z))
    left = [(-x, z) for (x, z) in reversed(pts[1:-1])]
    outline = pts + left
    flat_poly("sail", outline, P["sail"], bow=0.3)
    flat_poly("wing_l", [(-0.95, 0.15), (-0.55, 0.38), (-0.35, 0.05), (-0.6, -0.1)], P["accent2"], y=-0.006, bow=0.3)
    flat_poly("wing_r", [(0.95, 0.15), (0.6, -0.1), (0.35, 0.05), (0.55, 0.38)], P["accent2"], y=-0.006, bow=0.3)
    flat_poly("core", [(0, 0.8), (-0.12, 0.2), (0, -0.6), (0.12, 0.2)], P["accent"], y=-0.007, bow=0.3)
    rod("spine", (0, 0.02, -0.8), (0, 0.02, 0.95), 0.011, P["bamboo"])
    n = 12
    for i in range(n):
        x1 = -0.95 + 1.9 * i / n
        x2 = -0.95 + 1.9 * (i + 1) / n
        z1 = 0.15 + 0.3 * math.cos(x1 * math.pi / 2)
        z2 = 0.15 + 0.3 * math.cos(x2 * math.pi / 2)
        rod(f"arc{i}", (x1, 0.02 + 0.3 * x1 * x1, z1), (x2, 0.02 + 0.3 * x2 * x2, z2), 0.008, P["bamboo"])
    # ekor pita pendek
    for k in range(4):
        rod(f"tail{k}", (0, 0.02, -0.8 - 0.18 * k), (0.05 * (-1) ** k, 0.05, -0.98 - 0.18 * k), 0.018, P["tassel"], verts=4)
    rod("bridle1", (0, 0, 0.6), (0, -0.35, 0.1), 0.003, P["string"], verts=4)
    rod("bridle2", (0, 0, -0.5), (0, -0.35, 0.1), 0.003, P["string"], verts=4)
    join_all("KiteAcro")
    export("kite_acro.glb")


# --------------------------------------------------------------------------
# ENVIRONMENT
# --------------------------------------------------------------------------
def hip_roof(name, w, d, h, overhang, z0, material):
    hw, hd = w / 2 + overhang, d / 2 + overhang
    ridge = max(0.1, hw - hd) if hw > hd else 0.1
    v = [(-hw, -hd, z0), (hw, -hd, z0), (hw, hd, z0), (-hw, hd, z0),
         (-ridge, 0, z0 + h), (ridge, 0, z0 + h)]
    f = [(0, 1, 5, 4), (1, 2, 5), (2, 3, 4, 5), (3, 0, 4), (0, 3, 2, 1)]
    return mesh_from_pydata(name, v, f, material)


def gable_roof(name, w, d, h, overhang, z0, material):
    hw, hd = w / 2 + overhang, d / 2 + overhang
    v = [(-hw, -hd, z0), (hw, -hd, z0), (hw, hd, z0), (-hw, hd, z0), (-hw, 0, z0 + h), (hw, 0, z0 + h)]
    f = [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    return mesh_from_pydata(name, v, f, material)


def house(filename, roof="hip", wall_color=(0.93, 0.87, 0.72), roof_color=(0.66, 0.24, 0.12)):
    reset()
    wall = mat("Wall", wall_color, 0.95)
    roofm = mat("RoofTile", roof_color, 0.85)
    wood = mat("Wood", (0.36, 0.22, 0.12), 0.9)
    glass = mat("Window", (0.2, 0.3, 0.38), 0.3)
    base = mat("Foundation", (0.55, 0.53, 0.5), 1.0)
    w, d, h = 7.0, 6.0, 3.2
    box("foundation", (0, 0, 0.2), (w + 0.4, d + 0.4, 0.4), base)
    box("walls", (0, 0, 0.4 + h / 2), (w, d, h), wall)
    top = 0.4 + h
    if roof == "hip":
        hip_roof("roof", w, d, 2.2, 0.7, top, roofm)
    else:
        gable_roof("roof", w, d, 2.4, 0.7, top, roofm)
    box("door", (0.0, -d / 2 - 0.03, 0.4 + 1.05), (1.0, 0.1, 2.1), wood)
    for sx in (-1, 1):
        box(f"win{sx}", (sx * 2.2, -d / 2 - 0.03, 0.4 + 1.8), (1.2, 0.1, 1.0), glass)
        box(f"winframe{sx}", (sx * 2.2, -d / 2 - 0.05, 0.4 + 1.25), (1.4, 0.12, 0.12), wood)
        box(f"sidewin{sx}", (sx * (w / 2 + 0.03), 0, 0.4 + 1.8), (0.1, 1.2, 1.0), glass)
    # teras
    box("terrace", (0, -d / 2 - 1.0, 0.25), (w, 2.0, 0.3), base)
    for sx in (-1, 1):
        cylinder(f"post{sx}", (sx * (w / 2 - 0.3), -d / 2 - 1.8, 0.4 + h / 2), 0.12, h, wood, verts=8)
    join_all("House")
    export(filename)


def rooftop_base():
    """Rumah 2 lantai dengan dak beton datar - tempat pemain berdiri (atap = 6.0m)."""
    reset()
    wall = mat("Wall", (0.85, 0.83, 0.78), 0.95)
    wall2 = mat("WallAccent", (0.35, 0.55, 0.62), 0.95)
    concrete = mat("Concrete", (0.62, 0.6, 0.57), 1.0)
    glass = mat("Window", (0.2, 0.3, 0.38), 0.3)
    tank = mat("WaterTank", (0.95, 0.55, 0.1), 0.6)
    metal = mat("Metal", (0.6, 0.62, 0.65), 0.4, 0.8)
    w, d = 7.0, 7.0
    box("floor1", (0, 0, 1.5), (w, d, 3.0), wall)
    box("band", (0, 0, 3.05), (w + 0.2, d + 0.2, 0.2), wall2)
    box("floor2", (0, 0, 4.5), (w, d, 2.8), wall)
    box("slab", (0, 0, 5.95), (w + 0.3, d + 0.3, 0.3), concrete)
    # parapet
    for sx in (-1, 1):
        box(f"parX{sx}", (sx * (w / 2 + 0.05), 0, 6.45), (0.2, d + 0.3, 0.7), wall2)
        box(f"parY{sx}", (0, sx * (d / 2 + 0.05), 6.45), (w + 0.3, 0.2, 0.7), wall2)
    for fl, zc in ((1, 1.8), (2, 4.6)):
        for sx in (-1, 1):
            for face in (-1, 1):
                box(f"win{fl}{sx}{face}", (sx * 1.8, face * (d / 2 + 0.03), zc), (1.4, 0.1, 1.1), glass)
    box("door", (0, -d / 2 - 0.03, 1.05), (1.0, 0.1, 2.1), mat("Wood", (0.36, 0.22, 0.12), 0.9))
    # toren air + dudukan
    for sx in (-1, 1):
        for sy in (-1, 1):
            rod(f"leg{sx}{sy}", (2.2 + sx * 0.5, 2.2 + sy * 0.5, 6.1), (2.2 + sx * 0.5, 2.2 + sy * 0.5, 7.2), 0.05, metal)
    cylinder("tank", (2.2, 2.2, 7.9), 0.75, 1.4, tank, verts=16)
    sphere("tanktop", (2.2, 2.2, 8.6), 0.75, tank, seg=16, rings=8, hemi=True, scale=(1, 1, 0.35))
    # antena TV bambu
    rod("pole", (-2.6, 2.6, 6.1), (-2.6, 2.6, 11.0), 0.06, mat("Bamboo", (0.72, 0.56, 0.3), 0.9))
    rod("ant1", (-3.4, 2.6, 10.5), (-1.8, 2.6, 10.5), 0.03, metal)
    rod("ant2", (-3.2, 2.6, 10.0), (-2.0, 2.6, 10.0), 0.03, metal)
    # tangga naik ke dak
    for i in range(8):
        box(f"step{i}", (w / 2 + 0.6, -2.5 + i * 0.55, 0.4 + i * 0.75), (1.0, 0.5, 0.15), concrete)
    join_all("RooftopBase")
    export("rooftop_base.glb")


def player():
    reset()
    skin = mat("Skin", (0.76, 0.55, 0.38), 0.8)
    shirt = mat("Shirt", (0.9, 0.9, 0.9), 0.9)       # ditint client (warna pemain)
    pants = mat("Pants", (0.18, 0.2, 0.28), 0.9)
    cap = mat("Cap", (0.08, 0.08, 0.1), 0.8)
    reel = mat("Reel", (0.75, 0.75, 0.78), 0.35, 0.8)
    wood = mat("Wood", (0.36, 0.22, 0.12), 0.9)
    # kaki
    for sx in (-1, 1):
        box(f"leg{sx}", (sx * 0.12, 0, 0.42), (0.16, 0.2, 0.84), pants)
        box(f"shoe{sx}", (sx * 0.12, -0.05, 0.04), (0.18, 0.3, 0.08), cap)
    box("torso", (0, 0, 1.12), (0.46, 0.26, 0.6), shirt)
    sphere("head", (0, 0, 1.6), 0.16, skin, seg=10, rings=8)
    sphere("peci", (0, 0, 1.68), 0.165, cap, seg=10, rings=8, hemi=True, scale=(1, 1, 0.7))
    # lengan terangkat ke depan memegang kaleng/gelangan
    rod("armL", (-0.26, 0, 1.36), (-0.12, -0.42, 1.34), 0.05, shirt)
    rod("armR", (0.26, 0, 1.36), (0.12, -0.42, 1.34), 0.05, shirt)
    sphere("handL", (-0.1, -0.45, 1.34), 0.05, skin, seg=6, rings=4)
    sphere("handR", (0.1, -0.45, 1.34), 0.05, skin, seg=6, rings=4)
    c = cylinder("reel", (0, -0.47, 1.34), 0.1, 0.2, reel, verts=14)
    c.rotation_euler = (0, math.pi / 2, 0)
    cylinder("threadroll", (0, -0.47, 1.34), 0.085, 0.16, mat("ThreadRoll", (0.98, 0.96, 0.9), 0.6), verts=14).rotation_euler = (0, math.pi / 2, 0)
    rod("handle", (0.15, -0.47, 1.34), (0.26, -0.47, 1.34), 0.025, wood)
    join_all("Player")
    export("player.glb")


def palm():
    reset()
    trunk = mat("PalmTrunk", (0.45, 0.35, 0.22), 1.0)
    leaf = mat("PalmLeaf", (0.22, 0.52, 0.18), 0.8)
    coco = mat("Coconut", (0.35, 0.42, 0.12), 0.7)
    segs = 8
    prev = Vector((0, 0, 0))
    for i in range(1, segs + 1):
        t = i / segs
        p = Vector((0.9 * t * t, 0, 9.0 * t))
        rod(f"trunk{i}", prev, p, 0.22 - 0.07 * t, trunk, verts=8)
        prev = p
    top = prev
    for k in range(9):
        a = 2 * math.pi * k / 9 + 0.2
        dirv = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-math.sin(a), math.cos(a), 0))
        pts = []
        n = 6
        for j in range(n + 1):
            t = j / n
            c = top + dirv * (3.2 * t) + Vector((0, 0, 0.9 * t - 2.4 * t * t))
            wdt = 0.55 * math.sin(math.pi * min(1, t * 1.1))
            pts.append((c + side * wdt, c - side * wdt, c))
        verts, faces = [], []
        for j, (l, r, c) in enumerate(pts):
            verts += [tuple(l), tuple(c + Vector((0, 0, 0.08))), tuple(r)]
        for j in range(n):
            a0 = j * 3
            b0 = (j + 1) * 3
            faces.append((a0, b0, b0 + 1, a0 + 1))
            faces.append((a0 + 1, b0 + 1, b0 + 2, a0 + 2))
        mesh_from_pydata(f"frond{k}", verts, faces, leaf)
    for k in range(4):
        a = 2 * math.pi * k / 4
        sphere(f"coco{k}", top + Vector((math.cos(a) * 0.3, math.sin(a) * 0.3, -0.35)), 0.18, coco, seg=8, rings=6)
    join_all("Palm")
    export("palm.glb")


def tree():
    reset()
    trunk = mat("TreeTrunk", (0.35, 0.24, 0.15), 1.0)
    leaf = mat("TreeLeaf", (0.2, 0.45, 0.16), 0.9)
    leaf2 = mat("TreeLeaf2", (0.28, 0.55, 0.2), 0.9)
    rod("trunk", (0, 0, 0), (0, 0, 3.0), 0.3, trunk, verts=8)
    rod("br1", (0, 0, 2.2), (1.2, 0.3, 3.6), 0.15, trunk, verts=6)
    rod("br2", (0, 0, 2.4), (-1.0, -0.5, 3.8), 0.15, trunk, verts=6)
    blobs = [((0, 0, 4.6), 2.2, leaf), ((1.5, 0.4, 4.0), 1.6, leaf2), ((-1.4, -0.6, 4.2), 1.7, leaf2), ((0.2, -0.3, 5.8), 1.5, leaf)]
    for i, (c, r, m) in enumerate(blobs):
        sphere(f"blob{i}", c, r, m, seg=8, rings=6)
    join_all("Tree")
    export("tree.glb")


def mosque():
    reset()
    wall = mat("MosqueWall", (0.96, 0.95, 0.9), 0.9)
    dome = mat("Dome", (0.15, 0.55, 0.42), 0.4, 0.3)
    gold = mat("Gold", (0.95, 0.75, 0.25), 0.3, 1.0)
    glass = mat("Window", (0.2, 0.3, 0.38), 0.3)
    box("base", (0, 0, 0.3), (15, 15, 0.6), mat("Foundation", (0.55, 0.53, 0.5), 1.0))
    box("hall", (0, 0, 3.1), (12, 12, 5.0), wall)
    box("drum", (0, 0, 6.1), (7, 7, 1.0), wall)
    sphere("dome", (0, 0, 6.6), 3.6, dome, seg=20, rings=12, hemi=True, scale=(1, 1, 1.15))
    rod("spire", (0, 0, 10.6), (0, 0, 12.0), 0.1, gold)
    sphere("orb", (0, 0, 11.4), 0.3, gold, seg=8, rings=6)
    for sx in (-1, 1):
        for face in range(4):
            a = face * math.pi / 2
            x = math.cos(a) * 6.03 + (-math.sin(a)) * sx * 3
            y = math.sin(a) * 6.03 + math.cos(a) * sx * 3
            box(f"win{sx}{face}", (x, y, 3.2), (0.1 if face % 2 == 0 else 1.4, 1.4 if face % 2 == 0 else 0.1, 2.4), glass)
    # menara
    cylinder("minaret", (8.5, 8.5, 8.0), 0.9, 16.0, wall, verts=12)
    cylinder("balcony", (8.5, 8.5, 13.0), 1.3, 0.4, dome, verts=12)
    sphere("minaret_dome", (8.5, 8.5, 16.0), 1.0, dome, seg=12, rings=8, hemi=True, scale=(1, 1, 1.4))
    rod("minaret_spire", (8.5, 8.5, 17.3), (8.5, 8.5, 18.4), 0.08, gold)
    join_all("Mosque")
    export("mosque.glb")


def mountain():
    reset()
    rock = mat("Mountain", (0.32, 0.42, 0.3), 1.0)
    n = 28
    size = 200.0
    verts, faces = [], []
    for j in range(n + 1):
        for i in range(n + 1):
            x = (i / n - 0.5) * size
            y = (j / n - 0.5) * size
            r = math.sqrt(x * x + y * y) / (size / 2)
            h = max(0.0, 1.0 - r) ** 1.6 * 70.0
            h += noise.noise(Vector((x * 0.03, y * 0.03, 0.0))) * 10.0 * max(0.0, 1 - r)
            if r > 0.98:
                h = -2
            verts.append((x, y, h))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    mesh_from_pydata("mountain", verts, faces, rock)
    join_all("Mountain")
    export("mountain.glb")


if __name__ == "__main__":
    kite_speed()
    kite_heavy()
    kite_acro()
    house("house_a.glb", roof="hip")
    house("house_b.glb", roof="gable", wall_color=(0.78, 0.86, 0.8), roof_color=(0.45, 0.2, 0.14))
    rooftop_base()
    player()
    palm()
    tree()
    mosque()
    mountain()
    print("[ATW] all assets done ->", OUT)
