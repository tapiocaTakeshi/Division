import { Flow, FlowNode, FlowEdge } from "../types/flow";
import * as fs from "fs";
import * as path from "path";

export interface FlowTemplate {
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  config?: Flow["config"];
}

export class TemplateLoader {
  private templatesDir: string;
  private templates: Map<string, FlowTemplate> = new Map();

  constructor(templatesDir: string = path.join(__dirname, "../templates")) {
    this.templatesDir = templatesDir;
    this.loadTemplates();
  }

  private loadTemplates(): void {
    try {
      if (!fs.existsSync(this.templatesDir)) {
        console.warn(`Templates directory not found: ${this.templatesDir}`);
        return;
      }

      const files = fs.readdirSync(this.templatesDir);

      for (const file of files) {
        if (file.endsWith(".json")) {
          const templatePath = path.join(this.templatesDir, file);
          const content = fs.readFileSync(templatePath, "utf-8");
          const template = JSON.parse(content) as FlowTemplate;

          const templateName = file.replace(".json", "");
          this.templates.set(templateName, template);
        }
      }

      console.log(`Loaded ${this.templates.size} flow templates`);
    } catch (error) {
      console.error("Error loading templates:", error);
    }
  }

  getTemplate(name: string): FlowTemplate | undefined {
    return this.templates.get(name);
  }

  listTemplates(): Array<{ name: string; description: string }> {
    return Array.from(this.templates.entries()).map(([name, template]) => ({
      name,
      description: template.description,
    }));
  }

  createFlowFromTemplate(
    templateName: string,
    projectId: string,
    customName?: string
  ): Partial<Flow> {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template "${templateName}" not found`);
    }

    return {
      projectId,
      name: customName || template.name,
      description: template.description,
      nodes: template.nodes,
      edges: template.edges,
      config: template.config,
      status: "draft",
    };
  }
}
