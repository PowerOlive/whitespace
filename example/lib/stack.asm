printStackC:
  dup
  jz _printStackC
  printc
  jmp printStackC
_printStackC:
  drop
  ret

printStackI:
  dup
  jz _printStackI
  printi
  jmp printStackI
_printStackI:
  drop
  ret


