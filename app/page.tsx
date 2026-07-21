"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const fontSize = Math.max(17, width * 8.5);
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

  const mid = midpoint(dimStart, dimEnd);
  ctx.font = `600 ${fontSize}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textWidth = ctx.measureText(label).width;
  const boxW = textWidth + width * 10;
  const boxH = fontSize + width * 5;
  ctx.fillStyle = "rgba(255,255,255,.96)";
  ctx.fillRect(mid.x - boxW / 2, mid.y - boxH / 2, boxW, boxH);
  ctx.fillStyle = color;
  ctx.fillText(label, mid.x, mid.y);
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
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [scaleMmPerPixel, setScaleMmPerPixel] = useState<number | null>(null);
  const [knownLength, setKnownLength] = useState("200");
  const [knownUnit, setKnownUnit] = useState<Unit>("mm");
  const [displayUnit, setDisplayUnit] = useState<Unit>("mm");
  const [showUnit, setShowUnit] = useState(true);
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
  const [includeCalibration, setIncludeCalibration] = useState(false);
  const [toast, setToast] = useState("");
  const boardPadding = plan ? Math.round(Math.max(plan.naturalWidth,plan.naturalHeight)*.22) : 0;

  const allLines = useMemo(() => [...(calibration ? [calibration] : []), ...measurements], [calibration, measurements]);

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
    ctx.fillStyle="#f7f7f4";ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(plan,boardPadding,boardPadding);
    ctx.strokeStyle="#aeb5b2";ctx.lineWidth=1;ctx.strokeRect(boardPadding-.5,boardPadding-.5,plan.naturalWidth+1,plan.naturalHeight+1);
    const width = Math.max(1.5, Math.min(plan.naturalWidth, plan.naturalHeight) / 1000 * 1.8);
    const origin={x:boardPadding,y:boardPadding};
    if (calibration) drawArchitecturalDimension(ctx, {...calibration,offset:0}, "校准基准", "#eb7b42", width, true,origin);
    if (scaleMmPerPixel) measurements.forEach(line => drawArchitecturalDimension(ctx, line, formatLength(dist(line.start,line.end)*scaleMmPerPixel,displayUnit,showUnit), line.id===selectedId?"#00a994":"#b82933", width, false,origin));
    if (activeStart && hoverPoint) {
      const previewEnd=activeEnd??hoverPoint;
      const angle=Math.atan2(previewEnd.y-activeStart.y,previewEnd.x-activeStart.x),nx=-Math.sin(angle),ny=Math.cos(angle);
      const offset=activeEnd?(hoverPoint.x-activeStart.x)*nx+(hoverPoint.y-activeStart.y)*ny:0;
      const draft:Dimension = {id:"draft",start:activeStart,end:previewEnd,offset};
      const label = tool === "calibrate" ? "指定第二点" : scaleMmPerPixel ? formatLength(dist(activeStart,previewEnd)*scaleMmPerPixel,displayUnit,showUnit) : "指定第二点";
      drawArchitecturalDimension(ctx,draft,label,"#0b8d7b",width,true,origin);
    }
  }, [plan,boardPadding,calibration,measurements,scaleMmPerPixel,displayUnit,showUnit,selectedId,activeStart,activeEnd,hoverPoint,tool]);
  useEffect(() => renderCanvas(), [renderCanvas]);

  const commitPlan = useCallback((image: HTMLImageElement, imageFile: File) => {
    setPlan(image); setFile(imageFile); setCandidate(null); setCalibration(null); setMeasurements([]); setScaleMmPerPixel(null); setActiveStart(null); setActiveEnd(null); setSelectedId(null); setTool("calibrate"); setZoom(1); setPan({x:0,y:0}); setToast("图纸已载入：R 校准比例，F8 正交，F3 对象吸附");
  }, []);

  const loadFile = (nextFile: File) => {
    if (!nextFile.type.startsWith("image/")) return setToast("请上传 PNG、JPG 或 WebP 图片");
    const url = URL.createObjectURL(nextFile); const image = new Image();
    image.onload = () => { setCandidate({image,file:nextFile}); URL.revokeObjectURL(url); };
    image.src = url;
  };

  const applyCrop = (rect: CropRect) => {
    if (!candidate) return;
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
    if (osnap) {
      const exact: {point:Point;kind:SnapKind;priority:number}[]=[];
      allLines.forEach(line=>{ exact.push({point:line.start,kind:"端点",priority:0},{point:line.end,kind:"端点",priority:0},{point:midpoint(line.start,line.end),kind:"中点",priority:2}); });
      for(let i=0;i<allLines.length;i++)for(let j=i+1;j<allLines.length;j++){const p=segmentIntersection(allLines[i],allLines[j]);if(p)exact.push({point:p,kind:"交点",priority:1});}
      const near=exact.filter(c=>dist(c.point,raw)<=threshold).sort((a,b)=>a.priority-b.priority||dist(a.point,raw)-dist(b.point,raw))[0];
      if(near)return {point:near.point,snap:{point:near.point,kind:near.kind}};
      const endpoints=allLines.flatMap(line=>[line.start,line.end]);
      const nearX=endpoints.map(p=>({p,d:Math.abs(p.x-raw.x)})).filter(v=>v.d<=threshold).sort((a,b)=>a.d-b.d)[0];
      const nearY=endpoints.map(p=>({p,d:Math.abs(p.y-raw.y)})).filter(v=>v.d<=threshold).sort((a,b)=>a.d-b.d)[0];
      if(nearX||nearY){const p={x:nearX?nearX.p.x:raw.x,y:nearY?nearY.p.y:raw.y};return{point:p,snap:{point:p,kind:"对齐"}};}
    }
    const useOrtho=shift?!ortho:ortho;
    if(start&&useOrtho){const dx=Math.abs(raw.x-start.x),dy=Math.abs(raw.y-start.y);return{point:dx>=dy?{x:raw.x,y:start.y}:{x:start.x,y:raw.y},snap:null};}
    return {point:raw,snap:null};
  }, [plan, fitScale, zoom, osnap, allLines, ortho]);

  const completeCalibration = (line: Line) => { setPendingCalibration(line); setActiveStart(null); setActiveEnd(null); };

  const completeDimension = (line: Dimension) => {
    setMeasurements(items=>[...items,line]);setSelectedId(line.id);
    if(tool==="chain")setActiveStart(line.end); else setActiveStart(null);
    setActiveEnd(null);
  };

  const distanceToSegment=(p:Point,a:Point,b:Point)=>{const l2=(b.x-a.x)**2+(b.y-a.y)**2;if(!l2)return dist(p,a);const t=Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/l2));return dist(p,{x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)});};

  const selectAt=(p:Point)=>{const threshold=12/(fitScale*zoom);const hit=measurements.map(line=>{const angle=Math.atan2(line.end.y-line.start.y,line.end.x-line.start.x),nx=-Math.sin(angle),ny=Math.cos(angle);return{line,d:distanceToSegment(p,{x:line.start.x+nx*line.offset,y:line.start.y+ny*line.offset},{x:line.end.x+nx*line.offset,y:line.end.y+ny*line.offset})};}).filter(x=>x.d<=threshold).sort((a,b)=>a.d-b.d)[0];setSelectedId(hit?.line.id??null);};

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if(event.button===1||spaceRef.current)return;
    if(event.button!==0||!plan)return;
    if(tool==="select"){selectAt(rawPoint(event));return;}
    if(tool!=="calibrate"&&!scaleMmPerPixel)return;
    const resolved=resolvePoint(rawPoint(event),activeStart,event.shiftKey); setSnap(resolved.snap);
    if(!activeStart){setActiveStart(resolved.point);setHoverPoint(resolved.point);}
    else if(tool==="calibrate"&&dist(activeStart,resolved.point)>2)completeCalibration({id:crypto.randomUUID(),start:activeStart,end:resolved.point});
    else if(!activeEnd&&dist(activeStart,resolved.point)>2)setActiveEnd(resolved.point);
    else if(activeEnd){const angle=Math.atan2(activeEnd.y-activeStart.y,activeEnd.x-activeStart.x),nx=-Math.sin(angle),ny=Math.cos(angle);const raw=rawPoint(event);completeDimension({id:crypto.randomUUID(),start:activeStart,end:activeEnd,offset:(raw.x-activeStart.x)*nx+(raw.y-activeStart.y)*ny});}
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if(!plan)return; const stage=stageRef.current?.getBoundingClientRect(); if(stage)setCursor({x:event.clientX-stage.left,y:event.clientY-stage.top,visible:true});
    if(activeEnd){setHoverPoint(rawPoint(event));setSnap(null);return;}
    const resolved=resolvePoint(rawPoint(event),activeStart,event.shiftKey); setHoverPoint(resolved.point); setSnap(resolved.snap);
  };

  const switchTool=useCallback((next:Tool)=>{ if(next!=="select"&&next!=="calibrate"&&!scaleMmPerPixel)return; setTool(next);setActiveStart(null);setActiveEnd(null);setSnap(null); },[scaleMmPerPixel]);

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
      if(event.key==="Escape"){setActiveStart(null);setActiveEnd(null);setPendingCalibration(null);setSnap(null);setSelectedId(null);}
      if(event.key==="Enter"&&tool==="chain"){setActiveStart(null);setActiveEnd(null);}
      if((event.key==="Delete"||event.key==="Backspace")&&selectedId){event.preventDefault();setMeasurements(v=>v.filter(line=>line.id!==selectedId));setSelectedId(null);}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();setMeasurements(v=>v.slice(0,-1));}
      if(event.key==="0")resetView();
      if(event.key==="+")setZoom(v=>Math.min(8,v*1.2));
      if(event.key==="-")setZoom(v=>Math.max(.2,v/1.2));
    };
    const up=(event:KeyboardEvent)=>{if(event.code==="Space")spaceRef.current=false;};
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);};
  },[tool,selectedId,resetView,switchTool]);

  const confirmCalibration=()=>{if(!pendingCalibration)return;const actual=Number(knownLength)*UNIT_FACTOR[knownUnit];if(!actual||actual<=0)return setToast("请输入大于 0 的实际尺寸");setCalibration(pendingCalibration);setScaleMmPerPixel(actual/dist(pendingCalibration.start,pendingCalibration.end));setPendingCalibration(null);setTool("measure");setToast("比例已校准。D 单段标注，C 连续逐点标注");};

  const onWheel=(event:WheelEvent<HTMLDivElement>)=>{if(!plan)return;event.preventDefault();const r=event.currentTarget.getBoundingClientRect();const px=event.clientX-r.left-r.width/2,py=event.clientY-r.top-r.height/2;const factor=Math.exp(-event.deltaY*.0012);const next=Math.max(.2,Math.min(8,zoom*factor));const ratio=next/zoom;setPan({x:px-(px-pan.x)*ratio,y:py-(py-pan.y)*ratio});setZoom(next);};
  const onStagePointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{if(event.button===1||spaceRef.current){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setPanning(true);panRef.current={x:event.clientX,y:event.clientY,panX:pan.x,panY:pan.y};}};
  const onStagePointerMove=(event:ReactPointerEvent<HTMLDivElement>)=>{if(panRef.current){setPan({x:panRef.current.panX+event.clientX-panRef.current.x,y:panRef.current.panY+event.clientY-panRef.current.y});}};
  const stopPan=()=>{panRef.current=null;setPanning(false);};

  const exportImage=()=>{
    if(!plan||!file)return;
    let minX=0,minY=0,maxX=plan.naturalWidth,maxY=plan.naturalHeight;
    measurements.forEach(line=>{const a=Math.atan2(line.end.y-line.start.y,line.end.x-line.start.x),nx=-Math.sin(a),ny=Math.cos(a);for(const p of [line.start,line.end,{x:line.start.x+nx*line.offset,y:line.start.y+ny*line.offset},{x:line.end.x+nx*line.offset,y:line.end.y+ny*line.offset}]){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}});
    const margin=Math.max(24,Math.min(plan.naturalWidth,plan.naturalHeight)*.035);
    const outMinX=minX<0?minX-margin:0,outMinY=minY<0?minY-margin:0,outMaxX=maxX>plan.naturalWidth?maxX+margin:plan.naturalWidth,outMaxY=maxY>plan.naturalHeight?maxY+margin:plan.naturalHeight;
    const output=document.createElement("canvas");output.width=Math.ceil(outMaxX-outMinX);output.height=Math.ceil(outMaxY-outMinY);
    const ctx=output.getContext("2d");if(!ctx)return;const mime=["image/png","image/jpeg","image/webp"].includes(file.type)?file.type:"image/png";
    ctx.fillStyle="#f7f7f4";ctx.fillRect(0,0,output.width,output.height);const origin={x:-outMinX,y:-outMinY};ctx.drawImage(plan,origin.x,origin.y);
    const width=Math.max(1.5,Math.min(plan.naturalWidth,plan.naturalHeight)/1000*1.8);
    if(includeCalibration&&calibration)drawArchitecturalDimension(ctx,{...calibration,offset:0},"校准基准","#eb7b42",width,true,origin);
    if(scaleMmPerPixel)measurements.forEach(line=>drawArchitecturalDimension(ctx,line,formatLength(dist(line.start,line.end)*scaleMmPerPixel,displayUnit,showUnit),"#b82933",width,false,origin));
    output.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`${file.name.replace(/\.[^.]+$/,"")}-已标注.${mime==="image/jpeg"?"jpg":mime.split("/")[1]}`;a.click();URL.revokeObjectURL(url);},mime,.95);
  };

  const draftCommand=tool==="select"?selectedId?"已选择标注：按 Delete 删除":"选择标注对象":activeEnd?"指定尺寸线位置（可向上或向下）":activeStart?(tool==="chain"?"连续标注：指定下一点":"指定第二条尺寸界线原点"):tool==="calibrate"?"校准比例：指定第一点":tool==="chain"?"连续标注：指定起点":"线性标注：指定第一条尺寸界线原点";
  const snapScreen=useMemo(()=>{if(!snap||!plan)return null;const scale=fitScale*zoom;const boardW=plan.naturalWidth+boardPadding*2,boardH=plan.naturalHeight+boardPadding*2;return{x:stageSize.w/2+pan.x-boardW*scale/2+(snap.point.x+boardPadding)*scale,y:stageSize.h/2+pan.y-boardH*scale/2+(snap.point.y+boardPadding)*scale};},[snap,plan,boardPadding,fitScale,zoom,pan,stageSize]);

  return <main className="cad-app">
    <header className="cad-topbar"><div className="cad-brand"><span>刻</span><div><strong>刻度</strong><small>ARCH PLAN DIMENSION</small></div></div><div className="command-line"><b>命令:</b><span>_{draftCommand}</span></div><div className="top-actions"><button onClick={()=>fileInputRef.current?.click()}>打开图纸</button><button className="export" disabled={!measurements.length} onClick={exportImage}>导出图纸</button></div></header>
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
        {!plan?<button className="cad-empty" onClick={()=>fileInputRef.current?.click()}><b>＋</b><strong>打开一张平面图</strong><span>导入后可先裁切有效图纸范围</span><small>PNG · JPG · WEBP</small></button>:
          <div className="cad-canvas-wrap" style={{width:(plan.naturalWidth+boardPadding*2)*fitScale,height:(plan.naturalHeight+boardPadding*2)*fitScale,transform:`translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`}}><canvas ref={canvasRef} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerLeave={()=>setCursor(v=>({...v,visible:false}))} /></div>}
        {cursor.visible&&plan&&!panning&&<div className="fine-crosshair" style={{left:cursor.x,top:cursor.y}}><i/><b/></div>}
        {snap&&snapScreen&&<div className={`snap-marker snap-${snap.kind}`} style={{left:snapScreen.x,top:snapScreen.y}}><i/><span>{snap.kind}</span></div>}
        {pendingCalibration&&<div className="dynamic-input"><span>指定实际长度</span><label><input autoFocus value={knownLength} onChange={e=>setKnownLength(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")confirmCalibration();}}/><select value={knownUnit} onChange={e=>setKnownUnit(e.target.value as Unit)}><option>mm</option><option>cm</option><option>m</option></select></label><button onClick={confirmCalibration}>确认</button></div>}
      </div>

      <aside className="cad-properties"><div className="prop-title"><span>特性</span><strong>{tool==="select"?"选择与图层":tool==="calibrate"?"比例校准":tool==="chain"?"连续标注":"线性标注"}</strong></div><section><h3>图纸</h3><dl><div><dt>文件</dt><dd>{file?.name||"—"}</dd></div><div><dt>像素</dt><dd>{plan?`${plan.naturalWidth} × ${plan.naturalHeight}`:"—"}</dd></div><div><dt>比例</dt><dd className={scaleMmPerPixel?"ok":""}>{scaleMmPerPixel?`1 px = ${scaleMmPerPixel.toFixed(3)} mm`:"未校准"}</dd></div></dl></section><section><h3>尺寸样式</h3><label className="prop-field"><span>数值单位</span><select value={displayUnit} onChange={e=>setDisplayUnit(e.target.value as Unit)}><option>mm</option><option>cm</option><option>m</option></select></label><label className="prop-check"><input type="checkbox" checked={showUnit} onChange={e=>setShowUnit(e.target.checked)}/>在图中显示单位</label><label className="prop-check"><input type="checkbox" checked={includeCalibration} onChange={e=>setIncludeCalibration(e.target.checked)}/>导出校准线</label></section>{measurements.length>0&&<section className="layer-panel"><h3>标注图层</h3>{measurements.slice().reverse().map((line,index)=><button key={line.id} className={selectedId===line.id?"selected":""} onClick={()=>{setSelectedId(line.id);switchTool("select");}}><i>{measurements.length-index}</i><span>{scaleMmPerPixel?formatLength(dist(line.start,line.end)*scaleMmPerPixel,displayUnit,showUnit):"尺寸"}</span><b onClick={e=>{e.stopPropagation();setMeasurements(v=>v.filter(item=>item.id!==line.id));if(selectedId===line.id)setSelectedId(null);}}>×</b></button>)}</section>}<section><h3>对象捕捉</h3><p>端点 · 中点 · 交点 · 水平/垂直对齐</p><small>当前吸附已标注的几何点。图片墙线自动识别将在下一阶段加入。</small></section><section className="shortcut-card"><h3>快捷键</h3><dl><div><dt>V / Delete</dt><dd>选择 / 删除</dd></div><div><dt>R / D / C</dt><dd>校准 / 单段 / 连续</dd></div><div><dt>F8 / F3</dt><dd>正交 / 对象捕捉</dd></div><div><dt>滚轮</dt><dd>指针中心缩放</dd></div><div><dt>中键 / 空格</dt><dd>平移画布</dd></div><div><dt>Esc / Enter</dt><dd>取消 / 结束连续</dd></div></dl></section></aside>

      <footer className="cad-status"><div><button className={ortho?"on":""} onClick={()=>setOrtho(v=>!v)}><b>F8</b> 正交</button><button className={osnap?"on":""} onClick={()=>setOsnap(v=>!v)}><b>F3</b> 对象捕捉</button><span>十字光标</span></div><div><span>{measurements.length} 条尺寸</span><span>{Math.round(fitScale*zoom*100)}%</span><button onClick={resetView}>适合窗口</button></div></footer>
    </section>
    <input ref={fileInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];if(f)loadFile(f);e.target.value="";}}/>
    {candidate&&<CropDialog candidate={candidate} onCancel={()=>setCandidate(null)} onUseOriginal={()=>commitPlan(candidate.image,candidate.file)} onCrop={applyCrop}/>} 
    {toast&&<button className="toast" onClick={()=>setToast("")}>{toast}<span>×</span></button>}
  </main>;
}
