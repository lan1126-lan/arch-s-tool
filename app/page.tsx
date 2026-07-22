"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initAnalytics, trackEvent } from "./analytics";

type Point = { x: number; y: number };
type Line = { id: string; start: Point; end: Point };
type Dimension = Line & { offset: number };
type Tool = "select" | "calibrate" | "measure" | "chain";
type Unit = "mm" | "cm" | "m";
type SnapKind = "端点" | "中点" | "交点" | "对齐";
type SnapResult = { point: Point; kind: SnapKind };
type CropRect = { x: number; y: number; w: number; h: number };

const UNIT_FACTOR: Record<Unit, number> = { mm: 1, cm: 10, m: 1000 };
const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clipboardImageFile=(blob:Blob) => {
  const extension=blob.type==="image/jpeg"?"jpg":blob.type==="image/webp"?"webp":"png";
  return new File([blob],`clipboard-${Date.now()}.${extension}`,{type:blob.type||"image/png"});
};
const perpendicularOffset=(start:Point,end:Point,pointer:Point) => {
  const angle=Math.atan2(end.y-start.y,end.x-start.x);
  const nx=-Math.sin(angle),ny=Math.cos(angle);
  return (pointer.x-start.x)*nx+(pointer.y-start.y)*ny;
};
const offsetVector=(start:Point,end:Point,offset:number): Point => {
  const angle=Math.atan2(end.y-start.y,end.x-start.x);
  return {x:-Math.sin(angle)*offset,y:Math.cos(angle)*offset};
};
const reusedOffset=(start:Point,end:Point,vector:Point) => {
  const angle=Math.atan2(end.y-start.y,end.x-start.x);
  const nx=-Math.sin(angle),ny=Math.cos(angle);
  const distance=Math.hypot(vector.x,vector.y);
  return (Math.sign(vector.x*nx+vector.y*ny)||1)*distance;
};
const offsetDimensionLine=(line:Dimension): Line => {
  const angle=Math.atan2(line.end.y-line.start.y,line.end.x-line.start.x);
  const nx=-Math.sin(angle),ny=Math.cos(angle);
  return {id:`${line.id}-offset`,start:{x:line.start.x+nx*line.offset,y:line.start.y+ny*line.offset},end:{x:line.end.x+nx*line.offset,y:line.end.y+ny*line.offset}};
};

function formatLength(mm: number, unit: Unit, showUnit = true) {
  const value = mm / UNIT_FACTOR[unit];
  const number = unit === "mm" ? Math.round(value).toLocaleString("zh-CN") : value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return showUnit ? `${number} ${unit}` : number;
}

function segmentIntersection(a: Line, b: Line): Point | null {
  const x1 = a.start.x, y1 = a.start.y, x2 = a.end.x, y2 = a.end.y;
  const x3 = b.start.x, y3 = b.start.y, x4 = b.end.x, y4 = b.end.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < .0001) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denominator;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

function drawArchitecturalDimension(
  ctx: CanvasRenderingContext2D,
  line: Dimension,
  label: string,
  color: string,
  width: number,
  dashed = false,
  origin: Point = {x:0,y:0},
  fontSizeOverride?: number,
) {
  const { start, end } = line;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const nx = -Math.sin(angle), ny = Math.cos(angle);
  const baseStart = {x:start.x+origin.x,y:start.y+origin.y};
  const baseEnd = {x:end.x+origin.x,y:end.y+origin.y};
  const dimStart = {x:baseStart.x+nx*line.offset,y:baseStart.y+ny*line.offset};
  const dimEnd = {x:baseEnd.x+nx*line.offset,y:baseEnd.y+ny*line.offset};
  const extension = Math.max(13, width * 7);
  const tick = Math.max(9, width * 5);
  const fontSize = fontSizeOverride ?? Math.max(17, width * 8.5);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "square";
  ctx.setLineDash(dashed ? [width * 5, width * 3] : []);
  ctx.beginPath();
  ctx.moveTo(dimStart.x, dimStart.y);
  ctx.lineTo(dimEnd.x, dimEnd.y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const [base,p] of [[baseStart,dimStart],[baseEnd,dimEnd]] as [Point,Point][]) {
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(p.x + nx * Math.sign(line.offset || 1) * extension, p.y + ny * Math.sign(line.offset || 1) * extension);
    ctx.stroke();
    const slashAngle = angle + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(p.x - Math.cos(slashAngle) * tick, p.y - Math.sin(slashAngle) * tick);
    ctx.lineTo(p.x + Math.cos(slashAngle) * tick, p.y + Math.sin(slashAngle) * tick);
    ctx.stroke();
  }

  if(label){
    const mid = midpoint(dimStart, dimEnd);
    ctx.font = `600 ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const textWidth = ctx.measureText(label).width;
    const boxW = textWidth + width * 10;
    const boxH = fontSize + width * 5;
    const vertical=Math.abs(end.y-start.y)>Math.abs(end.x-start.x);
    ctx.save();
    ctx.translate(mid.x,mid.y);
    if(vertical)ctx.rotate(-Math.PI/2);
    ctx.fillStyle = "rgba(255,255,255,.96)";
    ctx.fillRect(-boxW / 2,-boxH / 2,boxW,boxH);
    ctx.fillStyle = color;
    ctx.fillText(label,0,0);
    ctx.restore();
  }
  ctx.restore();
}

function CropDialog({ candidate, onCancel, onUseOriginal, onCrop }: {
  candidate: { image: HTMLImageElement; file: File };
  onCancel: () => void;
  onUseOriginal: () => void;
  onCrop: (rect: CropRect) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const startRef = useRef<Point | null>(null);
  const cropPanRef = useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
  const [mode, setMode] = useState(false);
  const [rect, setRect] = useState<CropRect>({ x: 0, y: 0, w: candidate.image.naturalWidth, h: candidate.image.naturalHeight });
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPan, setCropPan] = useState({x:0,y:0});

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = candidate.image.naturalWidth;
    canvas.height = candidate.image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(candidate.image, 0, 0);
    if (mode) {
      ctx.fillStyle = "rgba(8,15,18,.55)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.drawImage(candidate.image, 0, 0);
      ctx.restore();
      ctx.strokeStyle = "#55e3ce";
      ctx.lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) / 600 * 2);
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.setLineDash([]);
      for (const p of [{x:rect.x,y:rect.y},{x:rect.x+rect.w,y:rect.y},{x:rect.x,y:rect.y+rect.h},{x:rect.x+rect.w,y:rect.y+rect.h}]) {
        ctx.fillStyle = "#55e3ce";
        ctx.fillRect(p.x - 6, p.y - 6, 12, 12);
      }
    }
  }, [candidate, mode, rect]);

  useEffect(() => paint(), [paint]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * candidate.image.naturalWidth / bounds.width, y: (event.clientY - bounds.top) * candidate.image.naturalHeight / bounds.height };
  };

  return <div className="crop-overlay" role="dialog" aria-label="导入图纸">
    <div className="crop-dialog">
      <div className="crop-head"><div><span>导入图纸</span><strong>{mode ? "框选要保留的范围" : "需要先裁切图纸吗？"}</strong><p>{mode ? "在图纸上拖出矩形范围，可重复框选。" : "去掉公众号边框、标题栏或无关留白，标注会更准确。"}</p></div><button onClick={onCancel}>×</button></div>
      <div className={`crop-preview ${mode ? "is-cropping" : ""}`} onWheel={(event)=>{if(!mode)return;event.preventDefault();setCropZoom(v=>Math.max(.35,Math.min(5,v*Math.exp(-event.deltaY*.0012))));}}>
        <canvas ref={canvasRef} style={{transform:`translate(${cropPan.x}px,${cropPan.y}px) scale(${cropZoom})`}}
        onPointerDown={(event) => { if (!mode) return; event.currentTarget.setPointerCapture(event.pointerId); if(event.button===1){event.preventDefault();cropPanRef.current={x:event.clientX,y:event.clientY,panX:cropPan.x,panY:cropPan.y};return;} if(event.button!==0)return; const p = point(event); startRef.current = p; setRect({x:p.x,y:p.y,w:0,h:0}); }}
        onPointerMove={(event) => { if(cropPanRef.current){setCropPan({x:cropPanRef.current.panX+event.clientX-cropPanRef.current.x,y:cropPanRef.current.panY+event.clientY-cropPanRef.current.y});return;} if (!mode || !startRef.current) return; const p = point(event), s = startRef.current; setRect({x:Math.min(s.x,p.x),y:Math.min(s.y,p.y),w:Math.abs(p.x-s.x),h:Math.abs(p.y-s.y)}); }}
        onPointerUp={() => { startRef.current = null; cropPanRef.current=null; }} onPointerCancel={()=>{startRef.current=null;cropPanRef.current=null;}} />
        {mode&&<div className="crop-help">滚轮缩放 · 中键拖动 · 左键框选裁切范围</div>}
      </div>
      <div className="crop-footer"><span>{candidate.image.naturalWidth} × {candidate.image.naturalHeight} px{mode && rect.w > 2 ? `　→　${Math.round(rect.w)} × ${Math.round(rect.h)} px` : ""}</span>{mode&&<div className="crop-zoom"><button onClick={()=>setCropZoom(v=>Math.max(.35,v/1.2))}>−</button><input aria-label="裁切缩放" type="range" min=".35" max="5" step=".05" value={cropZoom} onChange={e=>setCropZoom(Number(e.target.value))}/><button onClick={()=>setCropZoom(v=>Math.min(5,v*1.2))}>＋</button><b>{Math.round(cropZoom*100)}%</b><button onClick={()=>{setCropZoom(1);setCropPan({x:0,y:0});}}>复位</button></div>}<div>{mode ? <><button className="button ghost" onClick={() => setMode(false)}>返回</button><button className="button primary" disabled={rect.w < 10 || rect.h < 10} onClick={() => onCrop(rect)}>应用裁切</button></> : <><button className="button ghost" onClick={onUseOriginal}>直接使用原图</button><button className="button primary" onClick={() => setMode(true)}>裁切范围</button></>}</div></div>
    </div>
  </div>;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<HTMLImageElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [candidate, setCandidate] = useState<{ image: HTMLImageElement; file: File } | null>(null);
  const [tool, setTool] = useState<Tool>("calibrate");
  const [calibration, setCalibration] = useState<Line | null>(null);
  const [pendingCalibration, setPendingCalibration] = useState<Line | null>(null);
  const [measurements, setMeasurements] = useState<Dimension[]>([]);
  const [activeStart, setActiveStart] = useState<Point | null>(null);
  const [activeEnd, setActiveEnd] = useState<Point | null>(null);
  const [chainVector, setChainVector] = useState<Point | null>(null);
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [scaleMmPerPixel, setScaleMmPerPixel] = useState<number | null>(null);
  const [knownLength, setKnownLength] = useState("200");
  const [knownUnit, setKnownUnit] = useState<Unit>("mm");
  const [displayUnit, setDisplayUnit] = useState<Unit>("mm");
  const [showUnit, setShowUnit] = useState(true);
  const [dimensionFontSize, setDimensionFontSize] = useState(28);
  const [ortho, setOrtho] = useState(true);
  const [osnap, setOsnap] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [stageSize, setStageSize] = useState({w:0,h:0});
  const [pan, setPan] = useState({x:0,y:0});
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
  const spaceRef = useRef(false);
  const [cursor, setCursor] = useState<{x:number;y:number;visible:boolean}>({x:0,y:0,visible:false});
  const [showCalibration, setShowCalibration] = useState(false);
  const [toast, setToast] = useState("");
  const boardPadding = plan ? Math.round(Math.max(plan.naturalWidth,plan.naturalHeight)*.22) : 0;

  useEffect(() => { initAnalytics(); }, []);

  const allLines = useMemo(() => [
    ...(calibration ? [calibration] : []),
    ...measurements,
    ...measurements.map(offsetDimensionLine),
  ], [calibration, measurements]);

  const updateFit = useCallback(() => {
    if (!plan || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    setStageSize({w:r.width,h:r.height});
    const boardW=plan.naturalWidth+boardPadding*2,boardH=plan.naturalHeight+boardPadding*2;
    setFitScale(Math.min(1, Math.max(240, r.width - 70) / boardW, Math.max(200, r.height - 70) / boardH));
  }, [plan,boardPadding]);

  useEffect(() => { updateFit(); window.addEventListener("resize", updateFit); return () => window.removeEventListener("resize", updateFit); }, [updateFit]);

  const resetView = useCallback(() => { setZoom(1); setPan({x:0,y:0}); }, []);

  const renderCanvas = useCallback(() => {
    if (!plan || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = plan.naturalWidth+boardPadding*2; canvas.height = plan.naturalHeight+boardPadding*2;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(plan,boardPadding,boardPadding);
    const width = Math.max(1.5, Math.min(plan.naturalWidth, plan.naturalHeight) / 1000 * 1.8);
    const origin={x:boardPadding,y:boardPadding};
    if (calibration&&showCalibration) drawArchitecturalDimension(ctx, {...calibration,offset:0}, "校准基准", "#eb7b42", width, true,origin,dimensionFontSize);
    if (scaleMmPerPixel) measurements.forEach(line => drawArchitecturalDimension(ctx, line, formatLength(dist(line.start,line.end)*scaleMmPerPixel,displayUnit,showUnit), line.id===selectedId?"#00a994":"#b82933", width, false,origin,dimensionFontSize));
    if (activeStart && hoverPoint) {
      const previewEnd=activeEnd??hoverPoint;
      const offset=tool==="calibrate"?0:activeEnd?perpendicularOffset(activeStart,activeEnd,hoverPoint):tool==="chain"&&chainVector?reusedOffset(activeStart,hoverPoint,chainVector):0;
      const draft:Dimension = {id:"draft",start:activeStart,end:previewEnd,offset};
      const label = tool === "calibrate" || (!activeEnd&&!chainVector) ? "" : scaleMmPerPixel ? formatLength(dist(activeStart,previewEnd)*scaleMmPerPixel,displayUnit,showUnit) : "";
      drawArchitecturalDimension(ctx,draft,label,"#0b8d7b",width,true,origin,dimensionFontSize);
    }
  }, [plan,boardPadding,calibration,showCalibration,measurements,scaleMmPerPixel,displayUnit,showUnit,dimensionFontSize,selectedId,activeStart,activeEnd,chainVector,hoverPoint,tool]);
  useEffect(() => renderCanvas(), [renderCanvas]);

  const commitPlan = useCallback((image: HTMLImageElement, imageFile: File) => {
    const defaultFontSize=Math.round(Math.max(17,Math.min(400,Math.min(image.naturalWidth,image.naturalHeight)/1000*1.8*8.5)));
    setPlan(image); setFile(imageFile); setCandidate(null); setCalibration(null); setMeasurements([]); setScaleMmPerPixel(null); setActiveStart(null); setActiveEnd(null); setChainVector(null); setSelectedId(null); setDimensionFontSize(defaultFontSize); setTool("calibrate"); setZoom(1); setPan({x:0,y:0}); setToast("图纸已载入：R 校准比例，F8 正交，F3 对象吸附");
    trackEvent("image_ready");
  }, []);

  const loadFile = useCallback((nextFile: File, source: "upload" | "clipboard") => {
    if (!nextFile.type.startsWith("image/")) { trackEvent("image_rejected", source); return setToast("请上传 PNG、JPG 或 WebP 图片"); }
    trackEvent("image_selected", source);
    const url = URL.createObjectURL(nextFile); const image = new Image();
    image.onload = () => { setCandidate({image,file:nextFile}); URL.revokeObjectURL(url); };
    image.src = url;
  }, []);

  const pasteImageFromClipboard=useCallback(async()=>{
    if(!navigator.clipboard?.read)return setToast("当前浏览器不支持按钮读取，请直接按 Ctrl+V / ⌘V 粘贴图片");
    try{
      const items=await navigator.clipboard.read();
      for(const item of items){const type=item.types.find(value=>value.startsWith("image/"));if(type){loadFile(clipboardImageFile(await item.getType(type)),"clipboard");return;}}
      setToast("剪贴板里没有图片，请先复制图片或截屏");
    }catch{setToast("未获得剪贴板权限，请直接按 Ctrl+V / ⌘V 粘贴图片");}
  },[loadFile]);

  useEffect(()=>{
    const handlePaste=(event:ClipboardEvent)=>{
      const target=event.target as HTMLElement|null;
      if(target?.matches("input,textarea,select")||target?.isContentEditable)return;
      const image=Array.from(event.clipboardData?.items??[]).find(item=>item.type.startsWith("image/"))?.getAsFile();
      if(!image)return;
      event.preventDefault();loadFile(clipboardImageFile(image),"clipboard");
    };
    window.addEventListener("paste",handlePaste);return()=>window.removeEventListener("paste",handlePaste);
  },[loadFile]);

  const applyCrop = (rect: CropRect) => {
    if (!candidate) return;
    trackEvent("crop_decision", "cropped");
    const x=Math.max(0,Math.round(rect.x)), y=Math.max(0,Math.round(rect.y));
    const w=Math.min(candidate.image.naturalWidth-x,Math.round(rect.w)), h=Math.min(candidate.image.naturalHeight-y,Math.round(rect.h));
    const output=document.createElement("canvas"); output.width=w; output.height=h;
    const ctx=output.getContext("2d"); if(!ctx)return;
    ctx.drawImage(candidate.image,x,y,w,h,0,0,w,h);
    const mime=["image/png","image/jpeg","image/webp"].includes(candidate.file.type)?candidate.file.type:"image/png";
    output.toBlob(blob=>{ if(!blob)return; const nextFile=new File([blob],candidate.file.name,{type:mime}); const url=URL.createObjectURL(blob); const image=new Image(); image.onload=()=>{commitPlan(image,nextFile);URL.revokeObjectURL(url);}; image.src=url; },mime,.95);
  };

  const rawPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const r=event.currentTarget.getBoundingClientRect();
    return {x:(event.clientX-r.left)*event.currentTarget.width/r.width-boardPadding,y:(event.clientY-r.top)*event.currentTarget.height/r.height-boardPadding};
  };

  const resolvePoint = useCallback((raw: Point, start: Point|null, shift=false): {point:Point;snap:SnapResult|null} => {
    if (!plan) return {point:raw,snap:null};
    const threshold=11/(fitScale*zoom);
    const useOrtho=shift?!ortho:ortho;
    let target=raw;
    let axis:"horizontal"|"vertical"|null=null;
    if(start&&useOrtho){const dx=Math.abs(raw.x-start.x),dy=Math.abs(raw.y-start.y);axis=dx>=dy?"horizontal":"vertical";target=axis==="horizontal"?{x:raw.x,y:start.y}:{x:start.x,y:raw.y};}
    const keepOrtho=(p:Point)=>!start||!axis?p:axis==="horizontal"?{x:p.x,y:start.y}:{x:start.x,y:p.y};
    if (osnap) {
      const exact: {point:Point;kind:SnapKind;priority:number}[]=[];
      allLines.forEach(line=>{ exact.push({point:line.start,kind:"端点",priority:0},{point:line.end,kind:"端点",priority:0},{point:midpoint(line.start,line.end),kind:"中点",priority:2}); });
      for(let i=0;i<allLines.length;i++)for(let j=i+1;j<allLines.length;j++){const p=segmentIntersection(allLines[i],allLines[j]);if(p)exact.push({point:p,kind:"交点",priority:1});}
      const near=exact.filter(c=>dist(c.point,target)<=threshold).sort((a,b)=>a.priority-b.priority||dist(a.point,target)-dist(b.point,target))[0];
      if(near){const p=keepOrtho(near.point);return {point:p,snap:{point:p,kind:near.kind}};}
      const endpoints=allLines.flatMap(line=>[line.start,line.end]);
      if(!axis){const nearX=endpoints.map(p=>({p,d:Math.abs(p.x-target.x)})).filter(v=>v.d<=threshold).sort((a,b)=>a.d-b.d)[0];const nearY=endpoints.map(p=>({p,d:Math.abs(p.y-target.y)})).filter(v=>v.d<=threshold).sort((a,b)=>a.d-b.d)[0];if(nearX||nearY){const p={x:nearX?nearX.p.x:target.x,y:nearY?nearY.p.y:target.y};return{point:p,snap:{point:p,kind:"对齐"}};}}
    }
    return {point:target,snap:null};
  }, [plan, fitScale, zoom, osnap, allLines, ortho]);

  const completeCalibration = (line: Line) => { setPendingCalibration(line); setActiveStart(null); setActiveEnd(null); };

  const completeDimension = (line: Dimension) => {
    setMeasurements(items=>[...items,line]);setSelectedId(line.id);
    trackEvent("dimension_created", tool, measurements.length + 1);
    setActiveEnd(null);
    if(tool==="chain")setActiveStart(line.end); else setActiveStart(null);
  };

  const distanceToSegment=(p:Point,a:Point,b:Point)=>{const l2=(b.x-a.x)**2+(b.y-a.y)**2;if(!l2)return dist(p,a);const t=Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/l2));return dist(p,{x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)});};

  const selectAt=(p:Point)=>{const threshold=12/(fitScale*zoom);const hit=measurements.map(line=>{const angle=Math.atan2(line.end.y-line.start.y,line.end.x-line.start.x),nx=-Math.sin(angle),ny=Math.cos(angle);return{line,d:distanceToSegment(p,{x:line.start.x+nx*line.offset,y:line.start.y+ny*line.offset},{x:line.end.x+nx*line.offset,y:line.end.y+ny*line.offset})};}).filter(x=>x.d<=threshold).sort((a,b)=>a.d-b.d)[0];setSelectedId(hit?.line.id??null);};

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if(event.button===1||spaceRef.current)return;
    if(event.button!==0||!plan)return;
    if(tool==="select"){selectAt(rawPoint(event));return;}
    if(tool!=="calibrate"&&!scaleMmPerPixel)return;
    const raw=rawPoint(event);
    if(activeEnd&&activeStart){const offset=perpendicularOffset(activeStart,activeEnd,raw);if(Math.abs(offset)<2)return;if(tool==="chain")setChainVector(offsetVector(activeStart,activeEnd,offset));completeDimension({id:crypto.randomUUID(),start:activeStart,end:activeEnd,offset});setSnap(null);return;}
    const resolved=resolvePoint(raw,activeStart,event.shiftKey); setSnap(resolved.snap);
    if(!activeStart){setActiveStart(resolved.point);setHoverPoint(resolved.point);}
    else if(tool==="calibrate"&&dist(activeStart,resolved.point)>2)completeCalibration({id:crypto.randomUUID(),start:activeStart,end:resolved.point});
    else if(tool==="chain"&&chainVector&&dist(activeStart,resolved.point)>2)completeDimension({id:crypto.randomUUID(),start:activeStart,end:resolved.point,offset:reusedOffset(activeStart,resolved.point,chainVector)});
    else if(dist(activeStart,resolved.point)>2){setActiveEnd(resolved.point);setHoverPoint(raw);setSnap(null);}
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if(!plan)return; const stage=stageRef.current?.getBoundingClientRect(); if(stage)setCursor({x:event.clientX-stage.left,y:event.clientY-stage.top,visible:true});
    const raw=rawPoint(event);
    if(activeEnd){setHoverPoint(raw);setSnap(null);return;}
    const resolved=resolvePoint(raw,activeStart,event.shiftKey); setHoverPoint(resolved.point); setSnap(resolved.snap);
  };

  const switchTool=useCallback((next:Tool)=>{ if(next!=="select"&&next!=="calibrate"&&!scaleMmPerPixel)return; setTool(next);setActiveStart(null);setActiveEnd(null);setChainVector(null);setSnap(null);trackEvent("tool_selected",next); },[scaleMmPerPixel]);

  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{
      if((event.target as HTMLElement)?.matches("input,select,textarea"))return;
      if(event.code==="Space"){spaceRef.current=true;event.preventDefault();}
      if(event.key==="F8"){event.preventDefault();setOrtho(v=>!v);}
      if(event.key==="F3"){event.preventDefault();setOsnap(v=>!v);}
      if(event.key.toLowerCase()==="v")switchTool("select");
      if(event.key.toLowerCase()==="r")switchTool("calibrate");
      if(event.key.toLowerCase()==="d")switchTool("measure");
      if(event.key.toLowerCase()==="c")switchTool("chain");
      if(event.key==="Escape"){setActiveStart(null);setActiveEnd(null);setChainVector(null);setPendingCalibration(null);setSnap(null);setSelectedId(null);}
      if(event.key==="Enter"&&tool==="chain"){setActiveStart(null);setActiveEnd(null);setChainVector(null);}
      if((event.key==="Delete"||event.key==="Backspace")&&selectedId){event.preventDefault();setMeasurements(v=>v.filter(line=>line.id!==selectedId));setSelectedId(null);}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();setMeasurements(v=>v.slice(0,-1));}
      if(event.key==="0")resetView();
      if(event.key==="+")setZoom(v=>Math.min(8,v*1.2));
      if(event.key==="-")setZoom(v=>Math.max(.2,v/1.2));
    };
    const up=(event:KeyboardEvent)=>{if(event.code==="Space")spaceRef.current=false;};
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);};
  },[tool,selectedId,resetView,switchTool]);

  const confirmCalibration=()=>{if(!pendingCalibration)return;const actual=Number(knownLength)*UNIT_FACTOR[knownUnit];if(!actual||actual<=0)return setToast("请输入大于 0 的实际尺寸");setCalibration(pendingCalibration);setScaleMmPerPixel(actual/dist(pendingCalibration.start,pendingCalibration.end));setPendingCalibration(null);setTool("measure");setToast("比例已校准。D 单段标注，C 连续逐点标注");trackEvent("calibration_complete",knownUnit);};

  const onWheel=(event:WheelEvent<HTMLDivElement>)=>{if(!plan)return;event.preventDefault();const r=event.currentTarget.getBoundingClientRect();const px=event.clientX-r.left-r.width/2,py=event.clientY-r.top-r.height/2;const factor=Math.exp(-event.deltaY*.0012);const next=Math.max(.2,Math.min(8,zoom*factor));const ratio=next/zoom;setPan({x:px-(px-pan.x)*ratio,y:py-(py-pan.y)*ratio});setZoom(next);};
  const onStagePointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{if(event.button===1||spaceRef.current){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setPanning(true);panRef.current={x:event.clientX,y:event.clientY,panX:pan.x,panY:pan.y};}};
  const onStagePointerMove=(event:ReactPointerEvent<HTMLDivElement>)=>{if(panRef.current){setPan({x:panRef.current.panX+event.clientX-panRef.current.x,y:panRef.current.panY+event.clientY-panRef.current.y});}};
  const stopPan=()=>{panRef.current=null;setPanning(false);};

  const renderExportCanvas=()=>{
    if(!plan||!file)return;
    const output=document.createElement("canvas");output.width=plan.naturalWidth+boardPadding*2;output.height=plan.naturalHeight+boardPadding*2;
    const ctx=output.getContext("2d");if(!ctx)return;
    ctx.fillStyle="#fff";ctx.fillRect(0,0,output.width,output.height);const origin={x:boardPadding,y:boardPadding};ctx.drawImage(plan,origin.x,origin.y);
    const width=Math.max(1.5,Math.min(plan.naturalWidth,plan.naturalHeight)/1000*1.8);
    if(showCalibration&&calibration)drawArchitecturalDimension(ctx,{...calibration,offset:0},"校准基准","#eb7b42",width,true,origin,dimensionFontSize);
    if(scaleMmPerPixel)measurements.forEach(line=>drawArchitecturalDimension(ctx,line,formatLength(dist(line.start,line.end)*scaleMmPerPixel,displayUnit,showUnit),"#b82933",width,false,origin,dimensionFontSize));
    return output;
  };

  const exportImage=async(mode:"copy"|"save")=>{const output=renderExportCanvas();if(!output||!file)return;const blob=await new Promise<Blob|null>(resolve=>output.toBlob(resolve,"image/png"));if(!blob)return;if(mode==="copy"){try{await navigator.clipboard.write([new ClipboardItem({"image/png":blob})]);setToast("已复制透明 PNG，可直接粘贴到 PPT、Figma 或微信");trackEvent("export_success","copy",measurements.length);}catch{setToast("浏览器未允许复制图片，请使用保存 PNG");trackEvent("export_failed","copy");}return;}const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`${file.name.replace(/\.[^.]+$/,"")}-已标注.png`;a.click();URL.revokeObjectURL(url);setToast("PNG 已保存到本地");trackEvent("export_success","save",measurements.length);};

  const draftCommand=tool==="select"?selectedId?"已选择标注：按 Delete 删除":"选择标注对象":activeEnd?"第三点：自由指定尺寸线位置":activeStart?(tool==="calibrate"?"校准比例：指定第二点":tool==="chain"&&chainVector?"逐点标注：指定下一点（单击生成）":"指定第二个测量点"):tool==="calibrate"?"校准比例：指定第一点":tool==="chain"?"逐点标注：第一段指定起点":"线性标注：指定第一个测量点";
  const snapScreen=useMemo(()=>{if(!snap||!plan)return null;const scale=fitScale*zoom;const boardW=plan.naturalWidth+boardPadding*2,boardH=plan.naturalHeight+boardPadding*2;return{x:stageSize.w/2+pan.x-boardW*scale/2+(snap.point.x+boardPadding)*scale,y:stageSize.h/2+pan.y-boardH*scale/2+(snap.point.y+boardPadding)*scale};},[snap,plan,boardPadding,fitScale,zoom,pan,stageSize]);

  return <main className="cad-app">
    <header className="cad-topbar"><div className="cad-brand"><span>刻</span><div><strong>刻度</strong><small>ARCH PLAN DIMENSION</small></div></div><div className="command-line"><b>命令:</b><span>_{draftCommand}</span></div><div className="top-actions"><button onClick={()=>fileInputRef.current?.click()}>本地上传</button><button onClick={pasteImageFromClipboard}>粘贴图片</button><button disabled={!measurements.length} onClick={()=>exportImage("copy")}>复制图片</button><button className="export" disabled={!measurements.length} onClick={()=>exportImage("save")}>保存 PNG</button></div></header>
    <section className="cad-workspace">
      <aside className="cad-tools">
        <button className={tool==="select"?"active":""} disabled={!plan} onClick={()=>switchTool("select")}><b>V</b><span>选择删除</span></button>
        <button className={tool==="calibrate"?"active":""} disabled={!plan} onClick={()=>switchTool("calibrate")}><b>R</b><span>比例校准</span></button>
        <button className={tool==="measure"?"active":""} disabled={!scaleMmPerPixel} onClick={()=>switchTool("measure")}><b>D</b><span>线性标注</span></button>
        <button className={tool==="chain"?"active":""} disabled={!scaleMmPerPixel} onClick={()=>switchTool("chain")}><b>C</b><span>连续标注</span></button>
        <i />
        <button disabled={!measurements.length} onClick={()=>setMeasurements(v=>v.slice(0,-1))}><b>↶</b><span>撤销</span></button>
        <button disabled={!plan} onClick={resetView}><b>0</b><span>全图</span></button>
      </aside>

      <div className={`cad-stage ${panning?"panning":""}`} ref={stageRef} onWheel={onWheel} onPointerDown={onStagePointerDown} onPointerMove={onStagePointerMove} onPointerUp={stopPan} onPointerCancel={stopPan} onPointerLeave={()=>{if(!panning)setCursor(v=>({...v,visible:false}));}}>
        {!plan?<div className="cad-empty"><b>＋</b><strong>导入一张平面图</strong><span>本地选择，或直接粘贴剪贴板图片</span><div className="empty-actions"><button onClick={()=>fileInputRef.current?.click()}>本地上传</button><button className="primary" onClick={pasteImageFromClipboard}>粘贴图片</button></div><small>Ctrl+V / ⌘V 直接粘贴 · PNG · JPG · WEBP</small></div>:
          <div className="cad-canvas-wrap" style={{width:(plan.naturalWidth+boardPadding*2)*fitScale,height:(plan.naturalHeight+boardPadding*2)*fitScale,transform:`translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`}}><canvas ref={canvasRef} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerLeave={()=>setCursor(v=>({...v,visible:false}))} /></div>}
        {cursor.visible&&plan&&!panning&&<><div className="fine-crosshair"><i style={{left:cursor.x}}/><b style={{top:cursor.y}}/><em style={{left:cursor.x,top:cursor.y}}/></div>{activeStart&&<div className="cursor-prompt" style={{left:cursor.x,top:cursor.y-28}}>{activeEnd?"第三点·放置尺寸线":tool==="chain"&&chainVector?"单击生成":"第二点"}</div>}</>}
        {snap&&snapScreen&&<div className={`snap-marker snap-${snap.kind}`} style={{left:snapScreen.x,top:snapScreen.y}}><i/><span>{snap.kind}</span></div>}
        {pendingCalibration&&<div className="dynamic-input"><span>指定实际长度</span><label><input autoFocus value={knownLength} onChange={e=>setKnownLength(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")confirmCalibration();}}/><select value={knownUnit} onChange={e=>setKnownUnit(e.target.value as Unit)}><option>mm</option><option>cm</option><option>m</option></select></label><button onClick={confirmCalibration}>确认</button></div>}
      </div>

      <aside className="cad-properties"><div className="prop-title"><span>特性</span><strong>{tool==="select"?"选择与图层":tool==="calibrate"?"比例校准":tool==="chain"?"连续标注":"线性标注"}</strong></div><section><h3>图纸</h3><dl><div><dt>文件</dt><dd>{file?.name||"—"}</dd></div><div><dt>像素</dt><dd>{plan?`${plan.naturalWidth} × ${plan.naturalHeight}`:"—"}</dd></div><div><dt>比例</dt><dd className={scaleMmPerPixel?"ok":""}>{scaleMmPerPixel?`1 px = ${scaleMmPerPixel.toFixed(3)} mm`:"未校准"}</dd></div></dl></section><section><h3>尺寸样式</h3><label className="prop-field"><span>数值单位</span><select value={displayUnit} onChange={e=>setDisplayUnit(e.target.value as Unit)}><option>mm</option><option>cm</option><option>m</option></select></label><label className="prop-range"><span>文字大小 <b>{dimensionFontSize} px</b></span><input aria-label="标注文字大小" type="range" min="12" max="400" step="1" value={dimensionFontSize} onChange={e=>setDimensionFontSize(Number(e.target.value))}/><small>12</small><small>400</small></label><label className="prop-check"><input type="checkbox" checked={showUnit} onChange={e=>setShowUnit(e.target.checked)}/>在图中显示单位</label><label className="prop-check"><input type="checkbox" checked={showCalibration} onChange={e=>setShowCalibration(e.target.checked)}/>显示校准基准</label><small>单段标注的第三点可自由定位。逐点标注的第一段确定距离和方向，之后每点一次自动生成下一段。</small></section><section><h3>导出</h3><small>复制与保存均输出屏幕上的完整白色图布，图纸和全部标注保持同一范围。</small></section>{measurements.length>0&&<section className="layer-panel"><h3>标注图层</h3>{measurements.slice().reverse().map((line,index)=><button key={line.id} className={selectedId===line.id?"selected":""} onClick={()=>{setSelectedId(line.id);switchTool("select");}}><i>{measurements.length-index}</i><span>{scaleMmPerPixel?formatLength(dist(line.start,line.end)*scaleMmPerPixel,displayUnit,showUnit):"尺寸"}</span><b onClick={e=>{e.stopPropagation();setMeasurements(v=>v.filter(item=>item.id!==line.id));if(selectedId===line.id)setSelectedId(null);}}>×</b></button>)}</section>}<section><h3>对象捕捉</h3><p>原点、偏移端点 · 中点 · 交点 · 水平/垂直对齐</p><small>尺寸线偏移后的两个端点也可直接吸附；F8 正交仍然优先。</small></section><section className="shortcut-card"><h3>快捷键</h3><dl><div><dt>V / Delete</dt><dd>选择 / 删除</dd></div><div><dt>R / D / C</dt><dd>校准 / 单段 / 逐点</dd></div><div><dt>F8 / F3</dt><dd>正交 / 对象捕捉</dd></div><div><dt>滚轮</dt><dd>仅缩放图纸</dd></div><div><dt>中键 / 空格</dt><dd>平移画布</dd></div></dl></section></aside>

      <footer className="cad-status"><div><button className={ortho?"on":""} onClick={()=>setOrtho(v=>!v)}><b>F8</b> 正交</button><button className={osnap?"on":""} onClick={()=>setOsnap(v=>!v)}><b>F3</b> 对象捕捉</button><span>十字光标</span></div><div><span>{measurements.length} 条尺寸</span><span>{Math.round(fitScale*zoom*100)}%</span><button onClick={resetView}>适合窗口</button></div></footer>
    </section>
    <input ref={fileInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];if(f)loadFile(f,"upload");e.target.value="";}}/>
    {candidate&&<CropDialog candidate={candidate} onCancel={()=>{trackEvent("crop_decision","cancelled");setCandidate(null);}} onUseOriginal={()=>{trackEvent("crop_decision","original");commitPlan(candidate.image,candidate.file);}} onCrop={applyCrop}/>}
    {toast&&<button className="toast" onClick={()=>setToast("")}>{toast.replace("已复制透明 PNG","已复制白色图布 PNG")}<span>×</span></button>}
  </main>;
}
