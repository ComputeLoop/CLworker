using System;
using System.Runtime.InteropServices;

namespace ComputeLoop
{
    public sealed class DirectMlAdapterInfo
    {
        public int DeviceId { get; private set; }
        public string Name { get; private set; }

        public DirectMlAdapterInfo(int deviceId, string name)
        {
            DeviceId = deviceId;
            Name = name;
        }
    }

    public static class DirectMlAdapter
    {
        private const string Factory1IdText = "770aae78-f26f-4dba-a829-253c83d1b387";
        private const int DxgiErrorNotFound = unchecked((int)0x887A0002);
        private const uint NvidiaVendorId = 0x10DE;
        private const uint SoftwareAdapterFlag = 2;

        [DllImport("dxgi.dll", EntryPoint = "CreateDXGIFactory1", CallingConvention = CallingConvention.StdCall)]
        private static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnumAdapters1Delegate(IntPtr factory, uint adapterIndex, out IntPtr adapter);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetDesc1Delegate(IntPtr adapter, out AdapterDescription1 description);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct AdapterDescription1
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string Description;
            public uint VendorId;
            public uint DeviceId;
            public uint SubSysId;
            public uint Revision;
            public UIntPtr DedicatedVideoMemory;
            public UIntPtr DedicatedSystemMemory;
            public UIntPtr SharedSystemMemory;
            public long AdapterLuid;
            public uint Flags;
        }

        public static DirectMlAdapterInfo FindNvidiaAdapter()
        {
            IntPtr factory = IntPtr.Zero;
            try
            {
                Guid factory1Id = new Guid(Factory1IdText);
                int createResult = CreateDXGIFactory1(ref factory1Id, out factory);
                if (createResult < 0) Marshal.ThrowExceptionForHR(createResult);

                IntPtr factoryVtable = Marshal.ReadIntPtr(factory);
                IntPtr enumFunction = Marshal.ReadIntPtr(factoryVtable, 12 * IntPtr.Size);
                var enumerate = (EnumAdapters1Delegate)Marshal.GetDelegateForFunctionPointer(
                    enumFunction, typeof(EnumAdapters1Delegate));

                for (uint index = 0; index < 32; index++)
                {
                    IntPtr adapter = IntPtr.Zero;
                    int result = enumerate(factory, index, out adapter);
                    if (result == DxgiErrorNotFound) break;
                    if (result < 0) Marshal.ThrowExceptionForHR(result);

                    try
                    {
                        IntPtr adapterVtable = Marshal.ReadIntPtr(adapter);
                        IntPtr descFunction = Marshal.ReadIntPtr(adapterVtable, 10 * IntPtr.Size);
                        var getDescription = (GetDesc1Delegate)Marshal.GetDelegateForFunctionPointer(
                            descFunction, typeof(GetDesc1Delegate));
                        AdapterDescription1 description;
                        int descResult = getDescription(adapter, out description);
                        if (descResult < 0) Marshal.ThrowExceptionForHR(descResult);

                        if (description.VendorId == NvidiaVendorId &&
                            (description.Flags & SoftwareAdapterFlag) == 0)
                        {
                            return new DirectMlAdapterInfo((int)index, description.Description.Trim());
                        }
                    }
                    finally
                    {
                        Marshal.Release(adapter);
                    }
                }

                return null;
            }
            finally
            {
                if (factory != IntPtr.Zero) Marshal.Release(factory);
            }
        }
    }
}
