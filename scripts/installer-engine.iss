// 网页安装器与 Inno 通过独立临时目录交换进度；只有复制成功且进程正常退出才显示完成。
// 进度写 `阶段:百分比`（preparing/files/finishing/cleaning），网页按阶段取本地化文案；
// 旧的 Rust 外壳只认纯数字（解析不动就保持上一格），新外壳对纯数字回落到 files，两边都容忍。
var
  LastBridgeProgress: Integer;
  LastBridgeStage: String;

procedure WriteBridgeStage(Stage: String; Percent: Integer);
var StatusFile: String;
begin
  if ExpandConstant('{param:WEBUI|0}') <> '1' then Exit;
  StatusFile := ExpandConstant('{param:STATUSFILE|}');
  if StatusFile <> '' then SaveStringToFile(StatusFile, Stage + ':' + IntToStr(Percent), False);
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var Percent: Integer;
begin
  if (ExpandConstant('{param:WEBUI|0}') <> '1') or (MaxProgress <= 0) then Exit;
  Percent := Round(100.0 * CurProgress / MaxProgress);
  if (Percent = LastBridgeProgress) and (LastBridgeStage = 'files') then Exit;
  LastBridgeProgress := Percent;
  LastBridgeStage := 'files';
  WriteBridgeStage('files', Percent);
end;

procedure WriteBridgeDirectory;
var ResultFile: String;
begin
  if ExpandConstant('{param:WEBUI|0}') <> '1' then Exit;
  ResultFile := ExpandConstant('{param:RESULTFILE|}');
  // UTF-8 保留中文安装目录，Rust 不需要猜测当前系统代码页。
  if ResultFile <> '' then SaveStringToFile(ResultFile, UTF8Encode(ExpandConstant('{app}')), False);
end;
