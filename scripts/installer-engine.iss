// 网页安装器与 Inno 通过独立临时目录交换进度；只有复制成功且进程正常退出才显示完成。
var
  LastBridgeProgress: Integer;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var Percent: Integer; StatusFile: String;
begin
  if (ExpandConstant('{param:WEBUI|0}') <> '1') or (MaxProgress <= 0) then Exit;
  Percent := Round(100.0 * CurProgress / MaxProgress);
  if Percent = LastBridgeProgress then Exit;
  LastBridgeProgress := Percent;
  StatusFile := ExpandConstant('{param:STATUSFILE|}');
  if StatusFile <> '' then SaveStringToFile(StatusFile, IntToStr(Percent), False);
end;

procedure WriteBridgeDirectory;
var ResultFile: String;
begin
  if ExpandConstant('{param:WEBUI|0}') <> '1' then Exit;
  ResultFile := ExpandConstant('{param:RESULTFILE|}');
  // UTF-8 保留中文安装目录，Rust 不需要猜测当前系统代码页。
  if ResultFile <> '' then SaveStringToFile(ResultFile, UTF8Encode(ExpandConstant('{app}')), False);
end;
