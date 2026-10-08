// Fixed read-only probes. No user text or environment credentials enter these scripts.
export const windowsGpuCounters = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$engines = @(Get-CimInstance -ClassName Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{Name=$_.Name;UtilizationPercentage=[string]$_.UtilizationPercentage;Timestamp_Sys100NS=[string]$_.Timestamp_Sys100NS}
})
$memory = @(Get-CimInstance -ClassName Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{Name=$_.Name;DedicatedUsage=[string]$_.DedicatedUsage;SharedUsage=[string]$_.SharedUsage}
})
if ($engines.Count -gt 4096 -or $memory.Count -gt 64) { throw 'Counter limit exceeded' }
ConvertTo-Json -InputObject ([pscustomobject]@{engines=$engines;memory=$memory}) -Compress -Depth 4
`;

// DXGI 1.1 includes headless adapters. WMI also retains installed devices whose
// failed/disabled driver prevents DXGI enumeration. QWORD capacity is read only
// through the exact PNP instance's Enum.Driver link, never by model-name matching.
export const windowsGpuInventory = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dxgiRows = @()
$dxgiAvailable = $false
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace SudoCliPerformance {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct AdapterDesc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
    public uint Vendor, Device, Subsystem, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public Luid AdapterLuid;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct AdapterDesc1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
    public uint Vendor, Device, Subsystem, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public Luid AdapterLuid;
    public uint Flags;
  }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Factory {
    [PreserveSig] int SetPrivateData(ref Guid key, uint size, IntPtr data);
    [PreserveSig] int SetPrivateDataInterface(ref Guid key, IntPtr data);
    [PreserveSig] int GetPrivateData(ref Guid key, ref uint size, IntPtr data);
    [PreserveSig] int GetParent(ref Guid key, out IntPtr parent);
    [PreserveSig] int EnumAdapters(uint index, out IntPtr adapter);
    [PreserveSig] int MakeWindowAssociation(IntPtr window, uint flags);
    [PreserveSig] int GetWindowAssociation(out IntPtr window);
    [PreserveSig] int CreateSwapChain(IntPtr device, IntPtr desc, out IntPtr swapChain);
    [PreserveSig] int CreateSoftwareAdapter(IntPtr module, out IntPtr adapter);
    [PreserveSig] int EnumAdapters1(uint index, out Adapter adapter);
    [PreserveSig] [return:MarshalAs(UnmanagedType.Bool)] bool IsCurrent();
  }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Adapter {
    [PreserveSig] int SetPrivateData(ref Guid key, uint size, IntPtr data);
    [PreserveSig] int SetPrivateDataInterface(ref Guid key, IntPtr data);
    [PreserveSig] int GetPrivateData(ref Guid key, ref uint size, IntPtr data);
    [PreserveSig] int GetParent(ref Guid key, out IntPtr parent);
    [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
    [PreserveSig] int GetDesc(out AdapterDesc desc);
    [PreserveSig] int CheckInterfaceSupport(ref Guid iid, out long version);
    [PreserveSig] int GetDesc1(out AdapterDesc1 desc);
  }
  public sealed class Row { public string id, name; public ulong dedicatedBytes, sharedBytes; public uint vendorId, deviceId, subsysId; }
  public static class Inventory {
    [DllImport("dxgi.dll", ExactSpelling=true)] private static extern int CreateDXGIFactory1(ref Guid iid, out Factory factory);
    public static Row[] Read() {
      Factory factory = null;
      var rows = new List<Row>();
      try {
        var iid = typeof(Factory).GUID;
        Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid, out factory));
        for (uint i=0; i<64; i++) {
          Adapter adapter = null;
          int status = factory.EnumAdapters1(i, out adapter);
          if (status == unchecked((int)0x887A0002)) break;
          Marshal.ThrowExceptionForHR(status);
          try {
            AdapterDesc1 desc;
            Marshal.ThrowExceptionForHR(adapter.GetDesc1(out desc));
            // Microsoft software renderer has no physical adapter counters.
            if ((desc.Flags & 2) != 0 || desc.Vendor == 0x1414 && desc.Device == 0x8c) continue;
            rows.Add(new Row { id = String.Format("luid_0x{0:X8}_0x{1:X8}_phys_0", unchecked((uint)desc.AdapterLuid.High), desc.AdapterLuid.Low), name=desc.Description,
              dedicatedBytes=desc.DedicatedVideoMemory.ToUInt64()+desc.DedicatedSystemMemory.ToUInt64(), sharedBytes=desc.SharedSystemMemory.ToUInt64(),
              vendorId=desc.Vendor, deviceId=desc.Device, subsysId=desc.Subsystem });
          } finally { if (adapter != null) Marshal.ReleaseComObject(adapter); }
        }
        return rows.ToArray();
      } finally { if (factory != null) Marshal.ReleaseComObject(factory); }
    }
  }
}
'@
$dxgiRows = @([SudoCliPerformance.Inventory]::Read())
$dxgiAvailable = $true
} catch { $dxgiRows = @() }

$devices = @()
$devicesAvailable = $false
try {
  $controllers = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop)
  if ($controllers.Count -gt 64) { throw 'Device limit exceeded' }
  $devices = @($controllers | ForEach-Object {
    $controller = $_
    $pnp = [string]$controller.PNPDeviceID
    if ($pnp.Length -eq 0 -or $pnp.Length -gt 512 -or $pnp -notmatch '^[A-Za-z0-9_&\\\\#{}-]+$') { return }
    $dedicated = $null
    $capacitySource = 'unavailable'
    try {
      $instance = Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\' + $pnp) -ErrorAction Stop
      $driver = [string]$instance.Driver
      if ($driver -notmatch '^[{]4d36e968-e325-11ce-bfc1-08002be10318[}]\\\\[0-9]{4}$') { throw 'Not a display-class association' }
      $driverKey = Get-Item -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\' + $driver) -ErrorAction Stop
      try {
        if ($driverKey.GetValueKind('HardwareInformation.qwMemorySize') -eq [Microsoft.Win32.RegistryValueKind]::QWord) {
          $raw = $driverKey.GetValue('HardwareInformation.qwMemorySize', $null)
          if ($raw -is [long] -and $raw -ge 0) { $dedicated = [string]$raw; $capacitySource = 'windows-driver-registry-qword' }
        }
      } finally { $driverKey.Close() }
    } catch { }
    $code = $null
    if ($null -ne $controller.ConfigManagerErrorCode) { $code = [int]$controller.ConfigManagerErrorCode }
    $state = if ($null -ne $code -and $code -ne 0) { 'driver-error' } elseif ($code -eq 0 -and $controller.Status -eq 'OK') { 'ready' } else { 'unavailable' }
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { $identity = 'device_' + [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($pnp.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    $vendor = $null; $device = $null; $subsystem = $null
    if ($pnp -match '^PCI\\\\VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})&SUBSYS_([0-9A-F]{8})') {
      $vendor = [Convert]::ToUInt32($Matches[1],16); $device = [Convert]::ToUInt32($Matches[2],16); $subsystem = [Convert]::ToUInt32($Matches[3],16)
    }
    [pscustomobject]@{id=$identity;name=[string]$controller.Name;pnpDeviceId=$pnp;dedicatedBytes=$dedicated;sharedBytes=$null;capacitySource=$capacitySource;
      driverErrorCode=$code;deviceStatus=$state;identified=($pnp -match '^(PCI|USB)\\\\');vendorId=$vendor;deviceId=$device;subsysId=$subsystem}
  })
  $devicesAvailable = $true
} catch { $devices = @() }

$linked = @{}
$rows = @($dxgiRows | ForEach-Object {
  $gpu = $_
  $matching = @($devices | Where-Object { $null -ne $_.vendorId -and $_.vendorId -eq $gpu.vendorId -and $_.deviceId -eq $gpu.deviceId -and $_.subsysId -eq $gpu.subsysId })
  $sameDxgi = @($dxgiRows | Where-Object { $_.vendorId -eq $gpu.vendorId -and $_.deviceId -eq $gpu.deviceId -and $_.subsysId -eq $gpu.subsysId })
  $pnp = $null; $code = $null; $state = 'ready'; $identified = $true
  if ($matching.Count -eq 1 -and $sameDxgi.Count -eq 1) {
    $installed = $matching[0]; $pnp = $installed.pnpDeviceId; $code = $installed.driverErrorCode; $state = $installed.deviceStatus; $linked[$installed.id] = $true
  } elseif ($matching.Count -gt 1 -or $sameDxgi.Count -gt 1) {
    # Identical PCI model tuples are not proof of the same PNP instance.
    $identified = $false
  }
  [pscustomobject]@{id=$gpu.id;name=$gpu.name;pnpDeviceId=$pnp;dedicatedBytes=[string]$gpu.dedicatedBytes;sharedBytes=[string]$gpu.sharedBytes;
    capacitySource='dxgi';driverErrorCode=$code;deviceStatus=$state;identified=$identified}
})
$rows += @($devices | Where-Object { -not $linked.ContainsKey($_.id) } | Select-Object id,name,pnpDeviceId,dedicatedBytes,sharedBytes,capacitySource,driverErrorCode,deviceStatus,identified)
if ($rows.Count -gt 64) { throw 'Inventory limit exceeded' }
ConvertTo-Json -InputObject ([pscustomobject]@{adapters=$rows;complete=($dxgiAvailable -and $devicesAvailable)}) -Compress -Depth 4
`;
