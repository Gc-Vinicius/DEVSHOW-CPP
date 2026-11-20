import type { CompilerProfile, RoteiroLesson, TemplateSpec } from "../types";

export const COMPILER_PROFILES: CompilerProfile[] = [
  {
    id: "c11-rel",
    label: "gcc C11 64-bit (-Wall)",
    compiler: "gcc",
    stdFlag: "-std=c11",
    flags: ["-std=c11", "-Wall", "-Wextra", "-O2", "-static-libgcc"],
  },
  {
    id: "c11-dbg",
    label: "gcc C11 64-bit Debug (-g)",
    compiler: "gcc",
    stdFlag: "-std=c11",
    flags: ["-std=c11", "-Wall", "-Wextra", "-g", "-O0", "-static-libgcc"],
  },
  {
    id: "c99-strict",
    label: "gcc C99 64-bit estrito",
    compiler: "gcc",
    stdFlag: "-std=c99",
    flags: ["-std=c99", "-Wall", "-Wextra", "-pedantic", "-g", "-static-libgcc"],
  },
  {
    id: "cpp17-rel",
    label: "g++ C++17 64-bit (-Wall)",
    compiler: "g++",
    stdFlag: "-std=c++17",
    flags: ["-std=c++17", "-Wall", "-Wextra", "-O2", "-static-libgcc"],
  },
];

export const ROTEIRO_LESSONS: RoteiroLesson[] = [
  {
    fileName: "01_funcoes.c",
    block: "Bloco 1: Funções",
    time: "00:00–00:20",
    split: "15m PC / 5m papel",
    desc: "Retorno vs void e por que dobrar(int x) não altera x na main (passagem por valor).",
    paper: "No papel (5m): escrever int ehPar(int n) retornando 1 ou 0 e chamar na main.",
    code: `#include <stdio.h>

float calcularMedia(float n1, float n2) {
    return (n1 + n2) / 2.0f;
}

void dobrar(int x) {
    x = x * 2;
    printf("Dentro de dobrar: x copia = %d\\n", x);
}

int main(void) {
    float media = calcularMedia(7.5f, 9.0f);
    printf("Media das notas: %.2f\\n", media);

    int x = 10;
    printf("Antes de dobrar(x): x = %d\\n", x);
    dobrar(x);
    printf("Depois de dobrar(x): x ainda eh %d (passagem por valor!)\\n", x);
    return 0;
}
`,
  },
  {
    fileName: "02_matrizes.c",
    block: "Bloco 2: Matrizes",
    time: "00:20–00:40",
    split: "15m PC / 5m papel",
    desc: "Grade 3x3 com for duplo (linha i, coluna j), soma por linha e diagonal principal.",
    paper: "No papel (5m): for duplo numa 2x3 contando > 10 (cuidado pra não usar <=).",
    code: `#include <stdio.h>

int main(void) {
    int m[3][3] = {
        { 2, 5, 8 },
        { 9, 8, 7 },
        { 4, 8, 6 }
    };

    for (int i = 0; i < 3; i++) {
        int soma = 0;
        for (int j = 0; j < 3; j++) {
            soma += m[i][j];
        }
        printf("Linha %d -> soma = %d\\n", i, soma);
    }

    printf("Diagonal principal: ");
    for (int i = 0; i < 3; i++) {
        printf("m[%d][%d]=%d  ", i, i, m[i][i]);
    }
    printf("\\n");
    return 0;
}
`,
  },
  {
    fileName: "03_struct.c",
    block: "Bloco 3: Struct",
    time: "00:40–01:00",
    split: "15m PC / 5m papel",
    desc: "typedef struct Aluno, acesso com ponto (a.nota) e vetor de structs.",
    paper: "No papel (5m): struct Livro (titulo, paginas, preco) + conferir o ';' no fim!",
    code: `#include <stdio.h>

typedef struct {
    char nome[30];
    float nota;
} Aluno;

void imprimirMelhorAluno(Aluno turma[], int n) {
    int idx = 0;
    for (int i = 1; i < n; i++) {
        if (turma[i].nota > turma[idx].nota) {
            idx = i;
        }
    }
    printf("Maior nota: %s (%.1f)\\n", turma[idx].nome, turma[idx].nota);
}

int main(void) {
    Aluno turma[3] = {
        { "Lucas", 7.8f },
        { "Clara", 9.4f },
        { "Pedro", 8.1f }
    };
    printf("Turma cadastrada: 3 alunos\\n");
    imprimirMelhorAluno(turma, 3);
    return 0;
}
`,
  },
  {
    fileName: "04_ponteiros.c",
    block: "Bloco 4: Ponteiros e referência",
    time: "01:15–01:50",
    split: "20m PC / 15m papel",
    desc: "Endereços (&x e %p), *p alterando x, troca(&x, &y) e seta a->nota em struct.",
    paper: "No papel (15m): teste de mesa com caixinhas (x, y, *p) chamando troca(&x, &y).",
    code: `#include <stdio.h>

typedef struct {
    char nome[30];
    float nota;
} Aluno;

void troca(int *a, int *b) {
    int aux = *a;
    *a = *b;
    *b = aux;
}

void darBonus(Aluno *a, float pts) {
    a->nota += pts;
}

int main(void) {
    int x = 10;
    int y = 40;
    int *p = &x;

    printf("Endereco &x = %p | p guarda = %p | *p = %d\\n", (void *)&x, (void *)p, *p);
    *p = 25;
    printf("Apos *p = 25 -> x agora vale %d\\n", x);

    printf("Antes da troca: x = %d, y = %d\\n", x, y);
    troca(&x, &y);
    printf("Depois da troca: x = %d, y = %d\\n", x, y);

    Aluno ana = { "Ana", 7.5f };
    darBonus(&ana, 1.0f);
    printf("Aluno %s -> nota com bonus: %.1f\\n", ana.nome, ana.nota);
    return 0;
}
`,
  },
  {
    fileName: "05_ordenacao.c",
    block: "Bloco 5: Ordenação",
    time: "01:50–02:10",
    split: "13m PC / 7m papel",
    desc: "Bubble Sort reutilizando troca(&v[j], &v[j+1]) com print a cada passada.",
    paper: "No papel (7m): 2 passadas em [8, 4, 6, 1] e por que o loop para em n - 1.",
    code: `#include <stdio.h>

void troca(int *a, int *b) {
    int aux = *a;
    *a = *b;
    *b = aux;
}

void ordenar(int v[], int n) {
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (v[j] > v[j + 1]) {
                troca(&v[j], &v[j + 1]);
            }
        }
        printf("Passada %d: [%d, %d, %d, %d, %d]\\n", i + 1, v[0], v[1], v[2], v[3], v[4]);
    }
}

int main(void) {
    int v[5] = { 7, 3, 9, 2, 5 };
    ordenar(v, 5);
    return 0;
}
`,
  },
  {
    fileName: "06_busca_binaria.c",
    block: "Bloco 6: Busca binária",
    time: "02:10–02:30",
    split: "10m PC / 10m papel",
    desc: "while (ini <= fim), meio = (ini + fim)/2, meio+1 / meio-1 e return -1.",
    paper: "No papel (10m): escrever buscaBinaria do zero pelo esqueleto (compilador humano).",
    code: `#include <stdio.h>

int buscaBinaria(int v[], int n, int alvo) {
    int ini = 0, fim = n - 1;
    while (ini <= fim) {
        int meio = (ini + fim) / 2;
        printf("  ini=%d meio=%d (v[meio]=%d) fim=%d\\n", ini, meio, v[meio], fim);
        if (v[meio] == alvo) return meio;
        if (v[meio] < alvo)  ini = meio + 1;
        else                 fim = meio - 1;
    }
    return -1;
}

int main(void) {
    int v[8] = { 3, 7, 11, 19, 28, 42, 56, 70 };
    int pos = buscaBinaria(v, 8, 28);
    printf("Indice encontrado: %d\\n", pos);
    return 0;
}
`,
  },
  {
    fileName: "07_desafio_integrado.c",
    block: "Desafio final: 6 temas juntos",
    time: "Extra (30m)",
    split: "Struct, matriz, ptr e busca",
    desc: "Sistema de turma: notas[4][3] -> a->media -> ordena por matricula -> busca binaria.",
    paper: "Simulado completo de prova: conecta todos os 6 blocos em um único programa C.",
    code: `#include <stdio.h>

typedef struct {
    int matricula;
    float media;
} Aluno;

void calcularMediaAluno(Aluno *a, float notas[3]) {
    float soma = 0.0f;
    for (int j = 0; j < 3; j++) soma += notas[j];
    a->media = soma / 3.0f;
}

void trocaAluno(Aluno *a, Aluno *b) {
    Aluno aux = *a;
    *a = *b;
    *b = aux;
}

void ordenarPorMatricula(Aluno v[], int n) {
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (v[j].matricula > v[j + 1].matricula) {
                trocaAluno(&v[j], &v[j + 1]);
            }
        }
    }
}

int buscaPorMatricula(Aluno v[], int n, int mat) {
    int ini = 0, fim = n - 1;
    while (ini <= fim) {
        int meio = (ini + fim) / 2;
        if (v[meio].matricula == mat) return meio;
        if (v[meio].matricula < mat)  ini = meio + 1;
        else                          fim = meio - 1;
    }
    return -1;
}

int main(void) {
    float notas[4][3] = {
        { 9.0f, 8.5f, 9.8f },
        { 7.0f, 7.6f, 7.0f },
        { 8.5f, 8.5f, 8.5f },
        { 6.5f, 7.0f, 6.9f }
    };
    Aluno turma[4] = { {109, 0}, {105, 0}, {102, 0}, {114, 0} };

    for (int i = 0; i < 4; i++) calcularMediaAluno(&turma[i], notas[i]);
    ordenarPorMatricula(turma, 4);

    int idx = buscaPorMatricula(turma, 4, 109);
    if (idx != -1) {
        printf("Mat %d encontrada no indice %d -> media %.2f\\n",
               turma[idx].matricula, idx, turma[idx].media);
    }
    return 0;
}
`,
  },
];

export const C_TEMPLATES: TemplateSpec[] = [
  {
    id: "console-c11",
    cat: "Básico C",
    name: "Aplicação Console em C",
    desc: "Ponto de partida limpo em C11 com stdio.h e stdlib.h.",
    defaultFile: "main.c",
    code: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
    printf("Ola, DEVSHOW C++ em C11!\\n");
    return 0;
}
`,
  },
  {
    id: "struct-ptr",
    cat: "2º Semestre",
    name: "Struct + Ponteiro (a->campo)",
    desc: "Esqueleto pronto para praticar typedef struct e passagem por referência.",
    defaultFile: "exercicio_struct_ptr.c",
    code: `#include <stdio.h>

typedef struct {
    char titulo[40];
    int paginas;
    float preco;
} Livro;

void aplicarDesconto(Livro *l, float pct) {
    l->preco -= l->preco * pct;
}

int main(void) {
    Livro l = { "Linguagem C", 320, 80.0f };
    aplicarDesconto(&l, 0.15f);
    printf("%s -> R$ %.2f\\n", l.titulo, l.preco);
    return 0;
}
`,
  },
  {
    id: "matriz-2d",
    cat: "2º Semestre",
    name: "Matriz 2D (Linha × Coluna)",
    desc: "Base limpa para varredura de matrizes int m[L][C] com for duplo.",
    defaultFile: "exercicio_matriz.c",
    code: `#include <stdio.h>

#define LIN 2
#define COL 3

int main(void) {
    int m[LIN][COL] = {
        { 4, 12, 9 },
        { 15, 3, 22 }
    };
    int maiores = 0;
    for (int i = 0; i < LIN; i++) {
        for (int j = 0; j < COL; j++) {
            if (m[i][j] > 10) maiores++;
        }
    }
    printf("Maiores que 10: %d\\n", maiores);
    return 0;
}
`,
  },
  {
    id: "busca-binaria",
    cat: "Algoritmos",
    name: "Busca Binária + Swap",
    desc: "Esqueleto completo para treinar buscaBinaria e ordenação em C.",
    defaultFile: "exercicio_busca.c",
    code: `#include <stdio.h>

int buscaBinaria(int v[], int n, int alvo) {
    int ini = 0, fim = n - 1;
    while (ini <= fim) {
        int meio = (ini + fim) / 2;
        if (v[meio] == alvo) return meio;
        if (v[meio] < alvo)  ini = meio + 1;
        else                 fim = meio - 1;
    }
    return -1;
}

int main(void) {
    int v[6] = { 2, 5, 9, 14, 21, 30 };
    printf("Posicao do 14: %d\\n", buscaBinaria(v, 6, 14));
    return 0;
}
`,
  },
  {
    id: "malloc-free",
    cat: "Memória",
    name: "Alocação Dinâmica (malloc/free)",
    desc: "Vetor dinâmico seguro com verificação de NULL e liberação com free().",
    defaultFile: "vetor_dinamico.c",
    code: `#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int n = 5;
    int *v = (int *)malloc((size_t)n * sizeof(int));
    if (v == NULL) {
        fprintf(stderr, "Falha ao alocar memoria.\\n");
        return 1;
    }
    for (int i = 0; i < n; i++) v[i] = (i + 1) * 10;
    for (int i = 0; i < n; i++) printf("%d ", v[i]);
    printf("\\n");
    free(v);
    return 0;
}
`,
  },
  {
    id: "header-module",
    cat: "Modularização",
    name: "Header C (.h) com Include Guard",
    desc: "Arquivo de cabeçalho C separando protótipos e structs.",
    defaultFile: "utils_c.h",
    code: `#ifndef UTILS_C_H
#define UTILS_C_H

void troca_int(int *a, int *b);
int eh_par(int n);

#endif /* UTILS_C_H */
`,
  },
];
