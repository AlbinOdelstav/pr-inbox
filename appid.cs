using System;
using System.Runtime.InteropServices;

public static class AppId
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
        public PropertyKey(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort VarType;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PropertyKey key);
        int GetValue(ref PropertyKey key, out PropVariant value);
        int SetValue(ref PropertyKey key, ref PropVariant value);
        int Commit();
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile
    {
        int GetClassID(out Guid classId);
        int IsDirty();
        int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        int GetCurFile(out IntPtr fileName);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }

    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);

    static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    const uint RelaunchCommand = 2, RelaunchIcon = 3, RelaunchName = 4, Id = 5;

    static void Set(IPropertyStore store, uint propertyId, string value)
    {
        var key = new PropertyKey(AppUserModel, propertyId);
        var variant = new PropVariant { VarType = 31, Pointer = Marshal.StringToCoTaskMemUni(value) };
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant)); }
        finally { Marshal.FreeCoTaskMem(variant.Pointer); }
    }

    static IPropertyStore ForWindow(IntPtr window)
    {
        var iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref iid, out store));
        return store;
    }

    public static void SetWindow(IntPtr window, string id, string command, string name, string icon)
    {
        var store = ForWindow(window);
        try
        {
            Set(store, RelaunchCommand, command);
            Set(store, RelaunchName, name);
            Set(store, RelaunchIcon, icon);
            Set(store, Id, id);
        }
        finally { Marshal.ReleaseComObject(store); }
    }

    public static string GetWindow(IntPtr window)
    {
        var store = ForWindow(window);
        try
        {
            var key = new PropertyKey(AppUserModel, Id);
            PropVariant value;
            Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
            var text = value.VarType == 31 ? Marshal.PtrToStringUni(value.Pointer) : null;
            PropVariantClear(ref value);
            return text;
        }
        finally { Marshal.ReleaseComObject(store); }
    }

    public static void SetShortcut(string path, string id)
    {
        var link = new ShellLink();
        try
        {
            var file = (IPersistFile)link;
            Marshal.ThrowExceptionForHR(file.Load(path, 2));
            var store = (IPropertyStore)link;
            Set(store, Id, id);
            Marshal.ThrowExceptionForHR(store.Commit());
            Marshal.ThrowExceptionForHR(file.Save(path, true));
        }
        finally { Marshal.ReleaseComObject(link); }
    }
}
