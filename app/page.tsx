"use client";

import { ChangeEvent, DragEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };
type Line = { id: string; start: Point; end: Point };
type Tool = "calibrate" | "measure";
type Unit = "mm" | "cm" | "m";

const UNIT_FACTOR: Record<Unit, number> = { mm: 1, cm: 10, m: 1000 };

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function formatLength(mm: number, unit: Unit) {
  const value = mm / UNIT_FACTOR[unit];
  if (unit === "mm") return `${Math.round(value).toLocaleString("zh-CN")} mm`;
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function drawDimension(
  ctx: CanvasRenderingContext2D,
  line: Line,
  label: string,
  color: string,
  width: number,
  dashed = false,
) {
  const { start, end } = line;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const tick = Math.max(11, width * 5.5);
  const labelPadX = Math.max(10, width * 5);
  const labelPadY = Math.max(6, width * 3);
  const fontSize = Math.max(18, width * 9);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.setLineDash(dashed ? [width * 5, width * 4] : []);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const p of [start, end]) {
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(angle + Math.PI / 2) * tick, p.y + Math.sin(angle + Math.PI / 2) * tick);
    ctx.lineTo(p.x + Math.cos(angle - Math.PI / 2) * tick, p.y + Math.sin(angle - Math.PI / 2) * tick);
    ctx.stroke();
  }

  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  ctx.font = `600 ${fontSize}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const metrics = ctx.measureText(label);
  const boxW = metrics.width + labelPadX * 2;
  const boxH = fontSize + labelPadY * 2;
  ctx.fillStyle = "rgba(255,255,255,.94)";
  ctx.fillRect(midX - boxW / 2, midY - boxH / 2, boxW, boxH);
  ctx.strokeStyle = "rgba(16,24,32,.12)";
  ctx.lineWidth = Math.max(1, width * 0.5);
  ctx.strokeRect(midX - boxW / 2, midY - boxH / 2, boxW, boxH);
  ctx.fillStyle = color;
  ctx.fillText(label, midX, midY + width * 0.25);
  ctx.restore();
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<HTMLImageElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tool, setTool] = useState<Tool>("calibrate");
  const [draft, setDraft] = useState<Line | null>(null);
  const [calibration, setCalibration] = useState<Line | null>(null);
  const [pendingCalibration, setPendingCalibration] = useState<Line | null>(null);
  const [measurements, setMeasurements] = useState<Line[]>([]);
  const [scaleMmPerPixel, setScaleMmPerPixel] = useState<number | null>(null);
  const [knownLength, setKnownLength] = useState("200");
  const [knownUnit, setKnownUnit] = useState<Unit>("mm");
  const [displayUnit, setDisplayUnit] = useState<Unit>("mm");
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [includeCalibration, setIncludeCalibration] = useState(false);
  const [toast, setToast] = useState("");

  const updateFit = useCallback(() => {
    if (!plan || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const availableW = Math.max(240, rect.width - 96);
    const availableH = Math.max(240, rect.height - 96);
    setFitScale(Math.min(1, availableW / plan.naturalWidth, availableH / plan.naturalHeight));
  }, [plan]);

  useEffect(() => {
    updateFit();
    window.addEventListener("resize", updateFit);
    return () => window.removeEventListener("resize", updateFit);
  }, [updateFit]);

  const renderCanvas = useCallback(() => {
    if (!plan || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = plan.naturalWidth;
    canvas.height = plan.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(plan, 0, 0);
    const lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) / 900 * 2);
    if (calibration) drawDimension(ctx, calibration, "校准基准", "#e76f3c", lineWidth, true);
    if (scaleMmPerPixel) {
      measurements.forEach((line) =>
        drawDimension(ctx, line, formatLength(distance(line.start, line.end) * scaleMmPerPixel, displayUnit), "#ba2f36", lineWidth),
      );
    }
    if (draft) drawDimension(ctx, draft, tool === "calibrate" ? "绘制已知长度" : "测量中", "#287c74", lineWidth, true);
  }, [plan, calibration, scaleMmPerPixel, measurements, displayUnit, draft, tool]);

  useEffect(() => renderCanvas(), [renderCanvas]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setMeasurements((items) => items.slice(0, -1));
      }
      if (event.key === "Escape") {
        setDraft(null);
        setPendingCalibration(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadFile = (nextFile: File) => {
    if (!nextFile.type.startsWith("image/")) {
      setToast("请上传 PNG、JPG 或 WebP 图片");
      return;
    }
    const src = URL.createObjectURL(nextFile);
    const image = new Image();
    image.onload = () => {
      setPlan(image);
      setFile(nextFile);
      setCalibration(null);
      setMeasurements([]);
      setScaleMmPerPixel(null);
      setTool("calibrate");
      setZoom(1);
      setToast("平面图已载入，请先绘制一段已知长度");
      URL.revokeObjectURL(src);
    };
    image.src = src;
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) loadFile(nextFile);
    event.target.value = "";
  };

  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(event.currentTarget.width, (event.clientX - rect.left) * (event.currentTarget.width / rect.width))),
      y: Math.max(0, Math.min(event.currentTarget.height, (event.clientY - rect.top) * (event.currentTarget.height / rect.height))),
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!plan || (tool === "measure" && !scaleMmPerPixel)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = pointFromEvent(event);
    setDraft({ id: crypto.randomUUID(), start: p, end: p });
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const p = pointFromEvent(event);
    setDraft((line) => (line ? { ...line, end: p } : null));
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const completed = { ...draft, end: pointFromEvent(event) };
    setDraft(null);
    if (distance(completed.start, completed.end) < 4) return;
    if (tool === "calibrate") setPendingCalibration(completed);
    else setMeasurements((items) => [...items, completed]);
  };

  const confirmCalibration = () => {
    if (!pendingCalibration) return;
    const actualMm = Number(knownLength) * UNIT_FACTOR[knownUnit];
    const pixelLength = distance(pendingCalibration.start, pendingCalibration.end);
    if (!Number.isFinite(actualMm) || actualMm <= 0 || pixelLength <= 0) {
      setToast("请输入大于 0 的实际尺寸");
      return;
    }
    setCalibration(pendingCalibration);
    setScaleMmPerPixel(actualMm / pixelLength);
    setPendingCalibration(null);
    setTool("measure");
    setToast("比例已校准，现在可以连续标注尺寸");
  };

  const undo = () => {
    if (draft) return setDraft(null);
    if (measurements.length) return setMeasurements((items) => items.slice(0, -1));
    setCalibration(null);
    setScaleMmPerPixel(null);
    setTool("calibrate");
  };

  const exportImage = () => {
    if (!plan || !file) return;
    const output = document.createElement("canvas");
    output.width = plan.naturalWidth;
    output.height = plan.naturalHeight;
    const ctx = output.getContext("2d");
    if (!ctx) return;
    const mime = ["image/png", "image/jpeg", "image/webp"].includes(file.type) ? file.type : "image/png";
    if (mime === "image/jpeg") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, output.width, output.height);
    }
    ctx.drawImage(plan, 0, 0);
    const lineWidth = Math.max(2, Math.min(output.width, output.height) / 900 * 2);
    if (includeCalibration && calibration) drawDimension(ctx, calibration, "校准基准", "#e76f3c", lineWidth, true);
    if (scaleMmPerPixel) {
      measurements.forEach((line) =>
        drawDimension(ctx, line, formatLength(distance(line.start, line.end) * scaleMmPerPixel, displayUnit), "#ba2f36", lineWidth),
      );
    }
    output.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const originalName = file.name.replace(/\.[^.]+$/, "");
      const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
      a.href = url;
      a.download = `${originalName}-已标注.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      setToast(`已按原图 ${plan.naturalWidth} × ${plan.naturalHeight} px 导出`);
    }, mime, 0.94);
  };

  const calibratedText = useMemo(() => {
    if (!scaleMmPerPixel) return "尚未校准";
    return `1 px = ${scaleMmPerPixel < 1 ? scaleMmPerPixel.toFixed(3) : scaleMmPerPixel.toFixed(2)} mm`;
  }, [scaleMmPerPixel]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">刻</span>
          <div><strong>刻度</strong><span>平面图标注工作台</span></div>
        </div>
        <div className="project-meta">
          <span className={`status-dot ${scaleMmPerPixel ? "ready" : ""}`} />
          {file ? file.name : "未载入图纸"}
          {plan && <em>{plan.naturalWidth} × {plan.naturalHeight} px</em>}
        </div>
        <div className="top-actions">
          <button className="button ghost" onClick={() => fileInputRef.current?.click()}>更换图纸</button>
          <button className="button primary" disabled={!plan || measurements.length === 0} onClick={exportImage}>导出标注图</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="toolrail" aria-label="标注工具">
          <button className={tool === "calibrate" ? "active" : ""} disabled={!plan} onClick={() => setTool("calibrate")} title="比例校准">
            <span className="tool-icon">↔</span><small>校准</small>
          </button>
          <button className={tool === "measure" ? "active" : ""} disabled={!scaleMmPerPixel} onClick={() => setTool("measure")} title="连续标注">
            <span className="tool-icon">⌁</span><small>标注</small>
          </button>
          <div className="rail-divider" />
          <button disabled={!plan || (!measurements.length && !calibration)} onClick={undo} title="撤销 Ctrl+Z">
            <span className="tool-icon">↶</span><small>撤销</small>
          </button>
          <button disabled={!plan} onClick={() => setZoom((value) => Math.max(.35, value - .15))} title="缩小">
            <span className="tool-icon">−</span><small>缩小</small>
          </button>
          <button disabled={!plan} onClick={() => setZoom(1)} title="适合画布">
            <span className="tool-icon">⊡</span><small>适合</small>
          </button>
          <button disabled={!plan} onClick={() => setZoom((value) => Math.min(3, value + .15))} title="放大">
            <span className="tool-icon">＋</span><small>放大</small>
          </button>
        </aside>

        <div
          className={`stage ${dragging ? "dragging" : ""}`}
          ref={stageRef}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); const next = event.dataTransfer.files[0]; if (next) loadFile(next); }}
        >
          {!plan ? (
            <button className="upload-card" onClick={() => fileInputRef.current?.click()}>
              <span className="upload-symbol">＋</span>
              <strong>把平面图拖到这里</strong>
              <span>或点击选择 PNG、JPG、WebP 图片</span>
              <em>图纸只在当前浏览器中处理，不会上传</em>
            </button>
          ) : (
            <div className="canvas-wrap" style={{ width: plan.naturalWidth * fitScale * zoom, height: plan.naturalHeight * fitScale * zoom }}>
              <canvas
                ref={canvasRef}
                className={`plan-canvas tool-${tool}`}
                style={{ width: "100%", height: "100%" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDraft(null)}
              />
            </div>
          )}
          {plan && <div className="zoom-chip">{Math.round(fitScale * zoom * 100)}%</div>}
          {pendingCalibration && (
            <div className="calibration-popover" role="dialog" aria-label="输入基准尺寸">
              <div><span>已画基准线</span><strong>输入这段线的实际长度</strong></div>
              <label>
                <input autoFocus value={knownLength} onChange={(event) => setKnownLength(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirmCalibration(); }} inputMode="decimal" />
                <select value={knownUnit} onChange={(event) => setKnownUnit(event.target.value as Unit)}><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option></select>
              </label>
              <button className="button primary" onClick={confirmCalibration}>完成校准</button>
              <button className="icon-close" onClick={() => setPendingCalibration(null)} aria-label="关闭">×</button>
            </div>
          )}
        </div>

        <aside className="inspector">
          <div className="panel-heading"><span>当前任务</span><strong>{scaleMmPerPixel ? "标注尺寸" : "校准比例"}</strong></div>
          <ol className="steps">
            <li className={plan ? "done" : "current"}><i>{plan ? "✓" : "1"}</i><div><strong>载入平面图</strong><span>{plan ? "图纸已就绪" : "支持常用图片格式"}</span></div></li>
            <li className={scaleMmPerPixel ? "done" : plan ? "current" : ""}><i>{scaleMmPerPixel ? "✓" : "2"}</i><div><strong>校准真实比例</strong><span>{scaleMmPerPixel ? calibratedText : "沿已知墙厚或轴线画线"}</span></div></li>
            <li className={scaleMmPerPixel ? "current" : ""}><i>3</i><div><strong>连续标注并导出</strong><span>{measurements.length ? `已有 ${measurements.length} 条尺寸` : "校准后即可开始"}</span></div></li>
          </ol>

          <div className="panel-section">
            <label className="field-label" htmlFor="display-unit">标注显示单位</label>
            <div className="segmented" id="display-unit">
              {(["mm", "cm", "m"] as Unit[]).map((unit) => <button key={unit} className={displayUnit === unit ? "active" : ""} onClick={() => setDisplayUnit(unit)}>{unit}</button>)}
            </div>
          </div>

          <div className="panel-section compact">
            <div className="summary-row"><span>比例状态</span><strong className={scaleMmPerPixel ? "accent" : ""}>{calibratedText}</strong></div>
            <div className="summary-row"><span>尺寸标注</span><strong>{measurements.length} 条</strong></div>
            <label className="check-row"><input type="checkbox" checked={includeCalibration} onChange={(event) => setIncludeCalibration(event.target.checked)} /><span>导出时包含橙色校准线</span></label>
          </div>

          <div className="tip-card">
            <span>建筑师提示</span>
            <p>基准线越长，换算误差越小。优先选择轴线距离、开间或总尺寸；只有找不到长尺寸时，再使用 200 mm 墙厚。</p>
          </div>

          {measurements.length > 0 && (
            <div className="measurement-list">
              <div className="list-title"><span>尺寸列表</span><button onClick={() => setMeasurements([])}>清空</button></div>
              {measurements.slice().reverse().slice(0, 6).map((line, index) => (
                <div className="measure-item" key={line.id}><i>{measurements.length - index}</i><span>{scaleMmPerPixel ? formatLength(distance(line.start, line.end) * scaleMmPerPixel, displayUnit) : "—"}</span><button aria-label="删除该尺寸" onClick={() => setMeasurements((items) => items.filter((item) => item.id !== line.id))}>×</button></div>
              ))}
            </div>
          )}
        </aside>
      </section>

      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFileChange} />
      {toast && <button className="toast" onClick={() => setToast("")}>{toast}<span>×</span></button>}
    </main>
  );
}
