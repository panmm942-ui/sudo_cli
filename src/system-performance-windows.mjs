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

// DXGI uses pointer-sized memory fields, so capacities larger than 4 GiB stay intact.
// Only EnumAdapters/GetDesc are called; no device, workload, or graphics context is created.
export const windowsGpuInventory = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
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
  [ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Factory {
    [PreserveSig] int SetPrivateData(ref Guid key, uint size, IntPtr data);
    [PreserveSig] int SetPrivateDataInterface(ref Guid key, IntPtr data);
    [PreserveSig] int GetPrivateData(ref Guid key, ref uint size, IntPtr data);
    [PreserveSig] int GetParent(ref Guid key, out IntPtr parent);
    [PreserveSig] int EnumAdapters(uint index, out Adapter adapter);
  }
  [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Adapter {
    [PreserveSig] int SetPrivateData(ref Guid key, uint size, IntPtr data);
    [PreserveSig] int SetPrivateDataInterface(ref Guid key, IntPtr data);
    [PreserveSig] int GetPrivateData(ref Guid key, ref uint size, IntPtr data);
    [PreserveSig] int GetParent(ref Guid key, out IntPtr parent);
    [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
    [PreserveSig] int GetDesc(out AdapterDesc desc);
  }
  public sealed class Row { public string id, name; public ulong dedicatedBytes, sharedBytes; }
  public static class Inventory {
    [DllImport("dxgi.dll", ExactSpelling=true)] private static extern int CreateDXGIFactory(ref Guid iid, out Factory factory);
    public static Row[] Read() {
      Factory factory = null;
      var rows = new List<Row>();
      try {
        var iid = typeof(Factory).GUID;
        Marshal.ThrowExceptionForHR(CreateDXGIFactory(ref iid, out factory));
        for (uint i=0; i<64; i++) {
          Adapter adapter = null;
          int status = factory.EnumAdapters(i, out adapter);
          if (status == unchecked((int)0x887A0002)) break;
          Marshal.ThrowExceptionForHR(status);
          try {
            AdapterDesc desc;
            Marshal.ThrowExceptionForHR(adapter.GetDesc(out desc));
            // Microsoft software renderer has no physical adapter counters.
            if (desc.Vendor == 0x1414 && desc.Device == 0x8c) continue;
            rows.Add(new Row { id = String.Format("luid_0x{0:X8}_0x{1:X8}_phys_0", unchecked((uint)desc.AdapterLuid.High), desc.AdapterLuid.Low), name=desc.Description,
              dedicatedBytes=desc.DedicatedVideoMemory.ToUInt64()+desc.DedicatedSystemMemory.ToUInt64(), sharedBytes=desc.SharedSystemMemory.ToUInt64() });
          } finally { if (adapter != null) Marshal.ReleaseComObject(adapter); }
        }
        return rows.ToArray();
      } finally { if (factory != null) Marshal.ReleaseComObject(factory); }
    }
  }
}
'@
ConvertTo-Json -InputObject @([SudoCliPerformance.Inventory]::Read()) -Compress -Depth 3
`;
