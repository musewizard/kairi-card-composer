using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

// ThumbTool -- Windows Imaging Component (WIC) based checker for the card thumbnails.
//
// Why: this machine has the Microsoft WebP Image Extension installed, but its Appx manifest
// says "This is a Webp decoder" -- there is no WebP *encoder* anywhere on the box
// (no cwebp, no ffmpeg, no ImageMagick, no NuGet). So the cardcomposer writes its own
// minimal VP8L (lossless WebP) encoder, and this tool is the verifier: if WIC decodes our
// file and the pixels come back identical, every WIC consumer (the tool's own preview, the
// server admin panel, kairimod) will read it too.
//
// usage:
//   ThumbTool check <in.webp|png|...> [out.raw]   decode and optionally dump 32bppBGRA rows
//   ThumbTool info  <in.webp|png|...>            decode and print size / pixel format
class Program
{
    static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: ThumbTool <check|info> <file> [outRawBgra]");
            return 2;
        }
        string cmd = args[0], file = Path.GetFullPath(args[1]);
        if (!File.Exists(file)) { Console.Error.WriteLine("not found: " + file); return 2; }
        try
        {
            byte[] bgra;
            uint w, h;
            string fmt;
            if (!Wic.DecodeBgra(file, out bgra, out w, out h, out fmt))
            {
                Console.Error.WriteLine("DECODE FAILED: " + Wic.LastError);
                return 1;
            }
            Console.WriteLine(string.Format("decoded : {0}  {1}x{2}  format={3}  bytes={4}", Path.GetFileName(file), w, h, fmt, bgra.Length));
            if (args.Length > 2)
            {
                File.WriteAllBytes(Path.GetFullPath(args[2]), bgra);
                Console.WriteLine("raw     : " + Path.GetFullPath(args[2]) + " (32bppBGRA, top-down)");
            }
            Console.WriteLine("OK");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FAILED: " + ex.Message);
            return 1;
        }
    }
}

internal static class Wic
{
    internal static volatile string LastError = "";

    private static readonly Guid CLSID_WICImagingFactory = new Guid("CACAF262-9370-4615-A13B-9F5539DA4C0A");
    private static readonly Guid IID_IWICImagingFactory = new Guid("EC5EC8A9-C395-4314-9C77-54D7A935FF70");
    private static readonly Guid GUID_WICPixelFormat32bppBGRA = new Guid("6FDDC324-4E03-4BFE-B185-3D77768DC90F");

    private const uint CLSCTX_INPROC_SERVER = 0x1;
    private const uint GENERIC_READ = 0x80000000;
    private const int WICDecodeMetadataCacheOnLoad = 1;
    private const int WICBitmapInterpolationModeFant = 3;
    private const int WICBitmapDitherTypeNone = 0;
    private const int WICBitmapPaletteTypeCustom = 0;
    private const int CO_E_NOTINITIALIZED = unchecked((int)0x800401F0);
    private const int RPC_E_CHANGED_MODE = unchecked((int)0x80010106);
    private const uint COINIT_MULTITHREADED = 0x0;

    [DllImport("ole32.dll", EntryPoint = "CoCreateInstance", ExactSpelling = true, PreserveSig = true)]
    private static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IWICImagingFactory ppv);

    [DllImport("ole32.dll", EntryPoint = "CoInitializeEx", ExactSpelling = true)]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    // ---------------------------------------------------------------- interfaces (flattened)
    // NOTE: C# interface inheritance produces wrong COM vtable slots here (see kairimod's
    // CardThumbnails.cs for the measured evidence), so every interface repeats the
    // IWICBitmapSource methods verbatim at the front.

    [ComImport, Guid("EC5EC8A9-C395-4314-9C77-54D7A935FF70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICImagingFactory
    {
        [PreserveSig] int CreateDecoderFromFilename([MarshalAs(UnmanagedType.LPWStr)] string wzFilename,
            IntPtr pguidVendor, uint dwDesiredAccess, int metadataOptions, out IWICBitmapDecoder ppIDecoder);
        [PreserveSig] int CreateDecoderFromStream(IntPtr pIStream, IntPtr pguidVendor, int metadataOptions, out IWICBitmapDecoder ppIDecoder);
        [PreserveSig] int CreateDecoderFromFileHandle(IntPtr hFile, IntPtr pguidVendor, int metadataOptions, out IWICBitmapDecoder ppIDecoder);
        [PreserveSig] int CreateComponentInfo(IntPtr clsidComponent, out IntPtr ppIInfo);
        [PreserveSig] int CreateDecoder(IntPtr guidContainerFormat, IntPtr pguidVendor, out IWICBitmapDecoder ppIDecoder);
        [PreserveSig] int CreateEncoder(IntPtr guidContainerFormat, IntPtr pguidVendor, out IntPtr ppIEncoder);
        [PreserveSig] int CreatePalette(out IntPtr ppIPalette);
        [PreserveSig] int CreateFormatConverter(out IWICFormatConverter ppIFormatConverter);
        [PreserveSig] int CreateBitmapScaler(out IWICBitmapScaler ppIBitmapScaler);
        [PreserveSig] int CreateBitmapClipper(out IntPtr ppIBitmapClipper);
        [PreserveSig] int CreateBitmapFlipRotator(out IntPtr ppIBitmapFlipRotator);
        [PreserveSig] int CreateStream(out IWICStream ppIWICStream);
    }

    [ComImport, Guid("9EDDE9E7-8DEE-47EA-99DF-E6FAF2ED44BF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICBitmapDecoder
    {
        [PreserveSig] int QueryCapability(IntPtr pIStream, out uint pdwCapabilities);
        [PreserveSig] int Initialize(IntPtr pIStream, int metadataOptions);
        [PreserveSig] int GetContainerFormat(out Guid pguidContainerFormat);
        [PreserveSig] int GetDecoderInfo(out IntPtr ppIDecoderInfo);
        [PreserveSig] int CopyPalette(IntPtr pIPalette);
        [PreserveSig] int GetMetadataQueryReader(out IntPtr ppIMetadataQueryReader);
        [PreserveSig] int GetPreview(out IntPtr ppIBitmapSource);
        [PreserveSig] int GetColorContexts(uint cCount, IntPtr ppIColorContexts, out uint pcActualCount);
        [PreserveSig] int GetThumbnail(out IntPtr ppIThumbnail);
        [PreserveSig] int GetFrameCount(out uint pCount);
        [PreserveSig] int GetFrame(uint index, out IWICBitmapFrameDecode ppIBitmapFrame);
    }

    [ComImport, Guid("00000120-A8F2-4877-BA0A-FD2B6645FB94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICBitmapSource
    {
        [PreserveSig] int GetSize(out uint pnWidth, out uint pnHeight);
        [PreserveSig] int GetPixelFormat(out Guid pPixelFormat);
        [PreserveSig] int GetResolution(out double pDpiX, out double pDpiY);
        [PreserveSig] int CopyPalette(IntPtr pIPalette);
        [PreserveSig] int CopyPixels(IntPtr prc, uint cbStride, uint cbBufferSize, IntPtr pbBuffer);
    }

    [ComImport, Guid("3B16811B-6A43-4EC9-A813-3D930C13B940"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICBitmapFrameDecode
    {
        [PreserveSig] int GetSize(out uint pnWidth, out uint pnHeight);
        [PreserveSig] int GetPixelFormat(out Guid pPixelFormat);
        [PreserveSig] int GetResolution(out double pDpiX, out double pDpiY);
        [PreserveSig] int CopyPalette(IntPtr pIPalette);
        [PreserveSig] int CopyPixels(IntPtr prc, uint cbStride, uint cbBufferSize, IntPtr pbBuffer);
        [PreserveSig] int GetMetadataQueryReader(out IntPtr ppIMetadataQueryReader);
        [PreserveSig] int GetColorContexts(uint cCount, IntPtr ppIColorContexts, out uint pcActualCount);
        [PreserveSig] int GetThumbnail(out IntPtr ppIThumbnail);
    }

    [ComImport, Guid("00000302-A8F2-4877-BA0A-FD2B6645FB94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICBitmapScaler
    {
        [PreserveSig] int GetSize(out uint pnWidth, out uint pnHeight);
        [PreserveSig] int GetPixelFormat(out Guid pPixelFormat);
        [PreserveSig] int GetResolution(out double pDpiX, out double pDpiY);
        [PreserveSig] int CopyPalette(IntPtr pIPalette);
        [PreserveSig] int CopyPixels(IntPtr prc, uint cbStride, uint cbBufferSize, IntPtr pbBuffer);
        [PreserveSig] int Initialize(IWICBitmapSource pISource, uint uiWidth, uint uiHeight, int mode);
    }

    [ComImport, Guid("00000301-A8F2-4877-BA0A-FD2B6645FB94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICFormatConverter
    {
        [PreserveSig] int GetSize(out uint pnWidth, out uint pnHeight);
        [PreserveSig] int GetPixelFormat(out Guid pPixelFormat);
        [PreserveSig] int GetResolution(out double pDpiX, out double pDpiY);
        [PreserveSig] int CopyPalette(IntPtr pIPalette);
        [PreserveSig] int CopyPixels(IntPtr prc, uint cbStride, uint cbBufferSize, IntPtr pbBuffer);
        [PreserveSig] int Initialize(IWICBitmapSource pISource, ref Guid dstFormat, int dither, IntPtr pIPalette,
            double alphaThresholdPercent, int paletteType);
        [PreserveSig] int CanConvert(ref Guid srcPixelFormat, ref Guid dstPixelFormat, out int pfCanConvert);
    }

    [ComImport, Guid("135FF860-22B7-4DDF-B0F6-218F4F299A43"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICStream
    {
        int Read(IntPtr pv, uint cb, out uint pcbRead);
        int Write(IntPtr pv, uint cb, out uint pcbWritten);
        int Seek(long dlibMove, uint dwOrigin, out ulong plibNewPosition);
        int SetSize(ulong libNewSize);
        int CopyTo(IntPtr pstm, ulong cb, out ulong pcbRead, out ulong pcbWritten);
        int Commit(uint grfCommitFlags);
        int Revert();
        int LockRegion(ulong libOffset, ulong cb, uint dwLockType);
        int UnlockRegion(ulong libOffset, ulong cb, uint dwLockType);
        int Stat(IntPtr pstatstg, uint grfStatFlag);
        int Clone(out IntPtr ppstm);
        int InitializeFromIStream(IntPtr pIStream);
        int InitializeFromFilename([MarshalAs(UnmanagedType.LPWStr)] string wzFileName, uint dwDesiredAccess);
        int InitializeFromMemory(IntPtr pbBuffer, uint cbBufferSize);
        int InitializeFromIStreamRegion(IntPtr pIStream, ulong ulOffset, ulong ulMaxSize);
    }

    // ---------------------------------------------------------------- decode

    private static IWICImagingFactory CreateFactory(ref int hr)
    {
        int co = CoInitializeEx(IntPtr.Zero, COINIT_MULTITHREADED);
        if (co != 0 && co != RPC_E_CHANGED_MODE && co != CO_INITIALIZED_ALREADY)
        {
            LastError = "CoInitializeEx hr=0x" + co.ToString("X8");
            return null;
        }
        var clsid = CLSID_WICImagingFactory;
        var iid = IID_IWICImagingFactory;
        hr = CoCreateInstance(ref clsid, IntPtr.Zero, CLSCTX_INPROC_SERVER, ref iid, out var factory);
        return hr == 0 ? factory : null;
    }

    private const int CO_INITIALIZED_ALREADY = 1;

    internal static bool DecodeBgra(string path, out byte[] bgra, out uint width, out uint height, out string format)
    {
        bgra = null; width = 0; height = 0; format = "";
        IWICImagingFactory factory = null;
        IWICBitmapDecoder decoder = null;
        IWICBitmapFrameDecode frame = null;
        IWICFormatConverter converter = null;
        try
        {
            int hr = 0;
            factory = CreateFactory(ref hr);
            if (factory == null) { LastError = "CoCreateInstance(WICImagingFactory) hr=0x" + hr.ToString("X8"); return false; }
            hr = factory.CreateDecoderFromFilename(path, IntPtr.Zero, GENERIC_READ, WICDecodeMetadataCacheOnLoad, out decoder);
            if (hr != 0 || decoder == null) { LastError = "CreateDecoderFromFilename hr=0x" + hr.ToString("X8"); return false; }
            hr = decoder.GetFrame(0, out frame);
            if (hr != 0 || frame == null) { LastError = "GetFrame hr=0x" + hr.ToString("X8"); return false; }
            hr = frame.GetSize(out width, out height);
            if (hr != 0 || width == 0 || height == 0) { LastError = "GetSize hr=0x" + hr.ToString("X8"); return false; }
            hr = factory.CreateFormatConverter(out converter);
            if (hr != 0 || converter == null) { LastError = "CreateFormatConverter hr=0x" + hr.ToString("X8"); return false; }
            var fmt = GUID_WICPixelFormat32bppBGRA;
            // 显式转换：扁平化声明后 IWICBitmapFrameDecode 不再继承 IWICBitmapSource，
            // 但运行时 CLR 会用 QI 把它转成实现同一 COM 对象的另一个接口，实测可用。
            hr = converter.Initialize((IWICBitmapSource)frame, ref fmt, WICBitmapDitherTypeNone, IntPtr.Zero, 0.0, WICBitmapPaletteTypeCustom);
            if (hr != 0) { LastError = "FormatConverter.Initialize hr=0x" + hr.ToString("X8"); return false; }
            var got = Guid.Empty;
            converter.GetPixelFormat(out got);
            format = got.Equals(GUID_WICPixelFormat32bppBGRA) ? "32bppBGRA" : got.ToString();
            int stride = (int)width * 4;
            bgra = new byte[stride * (int)height];
            var handle = GCHandle.Alloc(bgra, GCHandleType.Pinned);
            try
            {
                hr = converter.CopyPixels(IntPtr.Zero, (uint)stride, (uint)bgra.Length, handle.AddrOfPinnedObject());
            }
            finally { handle.Free(); }
            if (hr != 0) { LastError = "CopyPixels hr=0x" + hr.ToString("X8"); bgra = null; return false; }
            return true;
        }
        finally
        {
            if (converter != null) Marshal.ReleaseComObject(converter);
            if (frame != null) Marshal.ReleaseComObject(frame);
            if (decoder != null) Marshal.ReleaseComObject(decoder);
            if (factory != null) Marshal.ReleaseComObject(factory);
        }
    }
}
