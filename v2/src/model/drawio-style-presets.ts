import type { DrawioStyleLibrary } from "./drawio-style-library";

export const DEFAULT_DRAWIO_STYLE_LIBRARY: DrawioStyleLibrary = {
  schemaVersion: 1,
  styles: [
    {
      id: "editorial",
      name: "Editorial",
      version: 1,
      description: "低饱和蓝灰，适合金融服务、企业架构和技术文档。",
      categories: {
        node: { fillColor: "#F4F7FB", strokeColor: "#617A99", fontColor: "#172B45", strokeWidth: "1.5", rounded: "1", shadow: "0", fontFamily: "Inter", fontSize: "12" },
        service: { fillColor: "#E6F0FF", strokeColor: "#3F6DAA", fontColor: "#17365F", strokeWidth: "1.6" },
        database: { fillColor: "#E3F2E8", strokeColor: "#3D8262", fontColor: "#174B35", strokeWidth: "1.6" },
        user: { fillColor: "#FFF0D2", strokeColor: "#A97926", fontColor: "#604313", strokeWidth: "1.5", rounded: "1" },
        external: { fillColor: "#F1E8FC", strokeColor: "#8761B4", fontColor: "#452A6B", strokeWidth: "1.5" },
        container: { fillColor: "#F8FAFD", strokeColor: "#9BAFC5", fontColor: "#344B66", strokeWidth: "1.2", rounded: "0", dashed: "0", shadow: "0" },
        edge: { strokeColor: "#526A86", fontColor: "#344B66", strokeWidth: "1.5", endArrow: "block", startArrow: "none", dashed: "0" },
        edgeDashed: { strokeColor: "#7487A0", fontColor: "#526A86", strokeWidth: "1.5", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "8 4" },
        edgeDotted: { strokeColor: "#7487A0", fontColor: "#526A86", strokeWidth: "1.5", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "1 4" }
      }
    },
    {
      id: "youth",
      name: "Vivid",
      version: 1,
      description: "高对比洋红与青蓝，适合演示和强调关键组件。",
      categories: {
        node: { fillColor: "#FFF5FB", strokeColor: "#A82F70", fontColor: "#4C1938", strokeWidth: "1.8", rounded: "1", shadow: "0", fontFamily: "Inter", fontSize: "12" },
        service: { fillColor: "#DDF5FF", strokeColor: "#147DA2", fontColor: "#06465D", strokeWidth: "1.9" },
        database: { fillColor: "#DFF8EC", strokeColor: "#16805A", fontColor: "#07553A", strokeWidth: "1.9" },
        user: { fillColor: "#FFE5F2", strokeColor: "#B91F6D", fontColor: "#741344", strokeWidth: "1.9", rounded: "1" },
        external: { fillColor: "#F1E5FF", strokeColor: "#8151C7", fontColor: "#452276", strokeWidth: "1.9" },
        container: { fillColor: "#FFF9FD", strokeColor: "#D47BAB", fontColor: "#673550", strokeWidth: "1.5", rounded: "0", dashed: "1", shadow: "0" },
        edge: { strokeColor: "#334F69", fontColor: "#233F57", strokeWidth: "1.8", endArrow: "block", startArrow: "none", dashed: "0" },
        edgeDashed: { strokeColor: "#A82F70", fontColor: "#741344", strokeWidth: "1.8", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "8 4" },
        edgeDotted: { strokeColor: "#147DA2", fontColor: "#06465D", strokeWidth: "1.8", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "1 4" }
      }
    },
    {
      id: "warm",
      name: "Warm paper",
      version: 1,
      description: "暖纸色、陶土色和橄榄绿，适合文档式架构说明。",
      categories: {
        node: { fillColor: "#FFFCF6", strokeColor: "#9B7A62", fontColor: "#38271F", strokeWidth: "1.5", rounded: "0", shadow: "0", fontFamily: "Inter", fontSize: "12" },
        service: { fillColor: "#FBE7D8", strokeColor: "#B35E3D", fontColor: "#632E20", strokeWidth: "1.6" },
        database: { fillColor: "#E5EBD8", strokeColor: "#6E8150", fontColor: "#384720", strokeWidth: "1.6" },
        user: { fillColor: "#F7E3B9", strokeColor: "#A87A24", fontColor: "#62450E", strokeWidth: "1.5", rounded: "0" },
        external: { fillColor: "#F0E2D8", strokeColor: "#98654C", fontColor: "#583725", strokeWidth: "1.5" },
        container: { fillColor: "#FFF9EF", strokeColor: "#C9AE91", fontColor: "#5D4939", strokeWidth: "1.2", rounded: "0", dashed: "0", shadow: "0" },
        edge: { strokeColor: "#795B49", fontColor: "#5D4939", strokeWidth: "1.5", endArrow: "block", startArrow: "none", dashed: "0" },
        edgeDashed: { strokeColor: "#A16A50", fontColor: "#79513F", strokeWidth: "1.5", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "8 4" },
        edgeDotted: { strokeColor: "#A16A50", fontColor: "#79513F", strokeWidth: "1.5", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "1 4" }
      }
    },
    {
      id: "midnight",
      name: "Midnight",
      version: 1,
      description: "深色填充与清晰描边，适合深色背景上的演示图。",
      categories: {
        node: { fillColor: "#202C40", strokeColor: "#839BC2", fontColor: "#F0F4FC", strokeWidth: "1.6", rounded: "1", shadow: "0", fontFamily: "Inter", fontSize: "12" },
        service: { fillColor: "#203B5D", strokeColor: "#78A9F2", fontColor: "#E5F1FF", strokeWidth: "1.8" },
        database: { fillColor: "#1E453B", strokeColor: "#79C6A7", fontColor: "#E1FFF3", strokeWidth: "1.8" },
        user: { fillColor: "#4D3820", strokeColor: "#E8BD70", fontColor: "#FFF4D9", strokeWidth: "1.7", rounded: "1" },
        external: { fillColor: "#3D2D55", strokeColor: "#BDA0F4", fontColor: "#F5EEFF", strokeWidth: "1.7" },
        container: { fillColor: "#182337", strokeColor: "#607493", fontColor: "#D6E1F2", strokeWidth: "1.3", rounded: "0", dashed: "1", shadow: "0" },
        edge: { strokeColor: "#B0C2DE", fontColor: "#D6E1F2", strokeWidth: "1.6", endArrow: "block", startArrow: "none", dashed: "0" },
        edgeDashed: { strokeColor: "#94AEE0", fontColor: "#C3D4F1", strokeWidth: "1.6", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "8 4" },
        edgeDotted: { strokeColor: "#94AEE0", fontColor: "#C3D4F1", strokeWidth: "1.6", endArrow: "block", startArrow: "none", dashed: "1", dashPattern: "1 4" }
      }
    }
  ]
};
